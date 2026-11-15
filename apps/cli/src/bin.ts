import { main } from './cli.js';

// What npm's `agentome` runs.
process.exitCode = await main(process.argv.slice(2));
