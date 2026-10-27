import {
  CopyDeadlineError,
  CopyFailureError,
  CopyRefusedError,
  CopyVerificationError,
  copyDatabase,
  countsForCli,
  TRANSFER_KINDS,
  type TransferCounts,
} from "@gachipad/storage";

console.log(
  "Source must be quiescent: stop the API and collab service first. Not copied: diagnostics, records that expired or expire within 15 minutes, and records of such or missing shares. The copy must finish within 10 minutes.",
);

let counts: TransferCounts = countsForCli();
try {
  const fromUrl = process.env.GACHIPAD_COPY_FROM;
  const toUrl = process.env.GACHIPAD_COPY_TO;
  if (!fromUrl || !toUrl)
    throw new CopyRefusedError("GACHIPAD_COPY_FROM and GACHIPAD_COPY_TO are required");
  const result = await copyDatabase(fromUrl, toUrl);
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
      "Result: failed (took longer than 10 minutes); drop the destination before retrying.",
    );
    process.exitCode = 1;
  } else {
    const code = error instanceof CopyFailureError && error.code ? ` (${error.code})` : "";
    console.log(`Result: failed${code}; drop the destination before retrying.`);
    process.exitCode = 1;
  }
}
