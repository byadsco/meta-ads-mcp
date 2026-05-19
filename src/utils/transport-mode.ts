export function isStdioTransport(argv: readonly string[]): boolean {
  let transport = "http";

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") break;

    if (arg === "--transport" || arg === "-t") {
      if (argv[i + 1] !== undefined) {
        transport = argv[i + 1];
        i++;
      }
      continue;
    }

    if (arg.startsWith("--transport=")) {
      transport = arg.slice("--transport=".length);
      continue;
    }

    if (arg.startsWith("-t") && arg.length > 2) {
      transport = arg.slice(2);
    }
  }

  return transport === "stdio";
}
