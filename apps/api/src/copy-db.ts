import {
  COPY_WINDOW_MINUTES,
  CopyDeadlineError,
  CopyFailureError,
  CopyRefusedError,
  CopyVerificationError,
  copyDatabase,
  countsForCli,
  TRANSFER_KINDS,
  type TransferCounts,
} from "@gachipad/storage";

// Unset or empty means the default; anything but a whole number in range is refused below.
const windowSetting =
  process.env.GACHIPAD_COPY_WINDOW_MINUTES || String(COPY_WINDOW_MINUTES.default);
const windowMinutes = /^\d{1,4}$/.test(windowSetting) ? Number(windowSetting) : Number.NaN;
const windowValid =
  windowMinutes >= COPY_WINDOW_MINUTES.min && windowMinutes <= COPY_WINDOW_MINUTES.max;

console.log(
  windowValid
    ? `Source must be quiescent: stop the API and collab service first. Copy window: ${windowMinutes} minutes. Not copied: diagnostics, records that expired or expire within ${windowMinutes} minutes, and records of such or missing shares. The copy must finish within ${windowMinutes - 5} minutes.`
    : "Source must be quiescent: stop the API and collab service first.",
);

let counts: TransferCounts = countsForCli();
try {
  if (!windowValid)
    throw new CopyRefusedError(
      `GACHIPAD_COPY_WINDOW_MINUTES must be a whole number from ${COPY_WINDOW_MINUTES.min} to ${COPY_WINDOW_MINUTES.max}`,
    );
  const fromUrl = process.env.GACHIPAD_COPY_FROM;
  const toUrl = process.env.GACHIPAD_COPY_TO;
  if (!fromUrl || !toUrl)
    throw new CopyRefusedError("GACHIPAD_COPY_FROM and GACHIPAD_COPY_TO are required");
  const result = await copyDatabase(fromUrl, toUrl, { windowMinutes });
  counts = result.counts;
  for (const kind of TRANSFER_KINDS) console.log(`${kind}: ${counts[kind]}`);
  console.log(`Result: success (SHA-256 ${result.digest}).`);
} catch (error) {
  if (
    error instanceof CopyFailureError ||
    error instanceof CopyVerificationError ||
    error instanceof CopyDeadlineError
  )
    counts = error.counts;
  for (const kind of TRANSFER_KINDS) console.log(`${kind}: ${counts[kind]}`);
  if (error instanceof CopyRefusedError) {
    console.log(`Result: refused (${error.message}).`);
    process.exitCode = 2;
  } else if (error instanceof CopyDeadlineError) {
    console.log(
      `Result: failed (took longer than ${error.minutes} minutes); drop the destination before retrying.`,
    );
    process.exitCode = 1;
  } else {
    const code = error instanceof CopyFailureError && error.code ? ` (${error.code})` : "";
    console.log(
      error instanceof CopyFailureError && !error.destinationWritten
        ? `Result: failed${code}; nothing was copied.`
        : `Result: failed${code}; drop the destination before retrying.`,
    );
    process.exitCode = 1;
  }
}
// A connection left in a timed-out operation must not keep the process alive.
process.stdout.write("", () => process.exit());
