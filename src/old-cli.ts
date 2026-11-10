#!/usr/bin/env node
// The bin `process-rules`, niyam's old name, in the bridge archive alone since P-54: it runs the same CLI, and says the new name to the owner (P-49).
import { main } from './main.ts';
import { OLD_CLI } from './names.ts';

await main(OLD_CLI);
