import { z } from "zod";

// Shared schemas run in the browser under a strict CSP. Disable Zod's optional code generation
// before any schema is constructed, including its otherwise caught eval capability probe.
z.config({ jitless: true });

export { z };
