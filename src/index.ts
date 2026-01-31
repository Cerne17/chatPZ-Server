import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

const WIKI_API_URL = "https://pzwiki.net/w/api.php";

const server = new McpServer({
  name: "PZ-Wiki-Agent",
  version: "1.0.0",
});

const cleanHtml = (html: string) => html.replace(/<[^>]*>?/gm, "").trim();

server.tool(
  "search_wiki",
  { query: z.string().describe("The item or topic to search for") },
  async ({ query }) => {
    const { data } = await axios.get(WIKI_API_URL, {
      params: {
        action: "query",
        list: "search",
        srsearch: query,
        format: "json",
      },
    });

    const results = data.query?.search?.map((r: any) => `- ${r.title}`).join("\n") || "No results.";
    return {
      content: [{ type: "text", text: `Search results for "${query}":\n${results}` }],
    };
  }
);

server.tool(
  "get_page_content",
  { title: z.string().describe("The exact title of the wiki page") },
  async ({ title }) => {
    const { data } = await axios.get(WIKI_API_URL, {
      params: {
        action: "parse",
        page: title,
        prop: "text",
        format: "json",
        disablelimitreport: 1,
      },
    });

    const rawHtml = data.parse?.text?.["*"] || "Page not found.";
    const text = cleanHtml(rawHtml);

    return {
      content: [{ type: "text", text: `Content for ${title}:\n\n${text.slice(0, 10000)}` }], // Cap at 10k chars
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
