# Meta Ads MCP Server

MCP (Model Context Protocol) server for managing Meta Ads (Facebook/Instagram) campaigns. Built for agencies managing multiple ad accounts.

## Features

- **31 tools** covering the full Meta Ads lifecycle
- **Multi-account support** — each request carries its own Meta access token
- **Cloud-ready** — Streamable HTTP transport, stateless, Docker-ready
- **Stdio support** — for local development with MCP clients
- **Rate limiting** — automatic throttling based on Meta API usage headers
- **Retry logic** — exponential backoff on transient errors

## Tools

| Category | Tools | Description |
|---|---|---|
| Accounts | 3 | List accounts, get info, get pages |
| Campaigns | 5 | CRUD + status management |
| Ad Sets | 5 | CRUD with full targeting spec |
| Ads | 5 | CRUD with creative assignment |
| Creatives | 4 | Create, update, image upload |
| Insights | 2 | Performance metrics with breakdowns |
| Targeting | 6 | Interest/behavior/geo search, audience estimation |
| Budget | 1 | Budget schedule management |

## Quick Start

### Prerequisites

- Node.js 20+
- A Meta access token with `ads_management` and `ads_read` permissions

### Install & Run

```bash
npm install
npm run build
npm start
```

The server starts on `http://localhost:3000` with the `/mcp` endpoint.

### Environment Variables

```bash
META_ACCESS_TOKEN=your_token    # Fallback token (optional if using Bearer auth)
META_API_VERSION=v22.0          # Graph API version
PORT=3000                       # Server port
LOG_LEVEL=info                  # debug | info | warn | error
```

### Authentication

**Multi-tenant (recommended for agencies):** Each request includes the Meta token in the Authorization header:

```
Authorization: Bearer <META_ACCESS_TOKEN>
```

**Single-tenant:** Set `META_ACCESS_TOKEN` environment variable.

### Local Development (stdio)

```bash
npm run dev:stdio
```

### Docker

```bash
docker compose up
```

## Connecting to Claude

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "node",
      "args": ["/path/to/meta-ads-mcp/dist/index.js", "--transport", "stdio"],
      "env": {
        "META_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
```

### Claude (remote HTTP)

Deploy the server and configure the MCP endpoint URL with Bearer token authentication:

```
URL: https://your-server.com/mcp
Headers: Authorization: Bearer <your_meta_token>
```

## Meta API Permissions

Your Meta access token needs these permissions:

- `ads_management` — Create and manage campaigns
- `ads_read` — Read campaign data and insights
- `pages_show_list` — List associated pages
- `pages_read_engagement` — Read page data

For agency use, create a System User in Business Manager with access to all client ad accounts.

## Development

```bash
npm run dev          # HTTP mode with hot reload
npm run dev:stdio    # Stdio mode with hot reload
npm run typecheck    # Type checking
npm run build        # Production build
```

## License

MIT
