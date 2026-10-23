import { storeContract } from "./contract.js";
import { createMemoryStores } from "./memory.js";

storeContract("memory stores", async () => createMemoryStores());
