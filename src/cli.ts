#!/usr/bin/env node
import "dotenv/config";
import packageJson from "../package.json" with { type: "json" };

type CommandName = "daemon";

interface CliOptions {
  command: CommandName;
  managementServerUrl?: string;
  daemonId?: string;
  daemonName?: string;
  help?: boolean;
  version?: boolean;
}

function printHelp(): void {
  console.log(`OhMyVibe CLI

Usage:
  ohmyvibe [command] [options]

Commands:
  daemon        Start the managed daemon (default)

Options:
  -u, --management-server-url <url>  Control server URL
  --daemon-id <id>                   Override daemon id
  -n, --daemon-name <name>           Override daemon display name
  -h, --help                         Show help
  -v, --version                      Show version

Examples:
  ohmyvibe --management-server-url http://localhost:3310
  ohmyvibe daemon -u http://localhost:3310 -n my-daemon
`);
}

function printVersion(): void {
  console.log(packageJson.version);
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseCliArgs(argv: string[]): CliOptions {
  let command: CommandName = "daemon";
  let startIndex = 0;

  const first = argv[0];
  if (first === "daemon") {
    command = first;
    startIndex = 1;
  }

  const options: CliOptions = { command };

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-u":
      case "--management-server-url":
        options.managementServerUrl = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--daemon-id":
        options.daemonId = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "-n":
      case "--daemon-name":
        options.daemonName = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function applyEnvOverrides(options: CliOptions): void {
  if (options.managementServerUrl) {
    process.env.MANAGEMENT_SERVER_URL = options.managementServerUrl;
  }
  if (options.daemonId) {
    process.env.DAEMON_ID = options.daemonId;
  }
  if (options.daemonName) {
    process.env.DAEMON_NAME = options.daemonName;
  }
}

async function run(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.version) {
    printVersion();
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  applyEnvOverrides(options);

  await import("./daemon/index.js");
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`OhMyVibe CLI error: ${message}`);
  process.exitCode = 1;
}
