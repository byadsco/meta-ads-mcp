import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSkillDocuments, type SkillDocument } from "./loader.js";
import { singleLine } from "../utils/single-line.js";

/**
 * Prompts start a job with the relevant skill already in hand, so a client
 * does not have to know which resource to read first. Arguments are strings,
 * which is all the MCP prompt protocol carries, and every one is flattened
 * before it reaches the text.
 */

const MAX_ARG_CHARS = 200;

function arg(value: string | undefined, max = MAX_ARG_CHARS): string {
  return singleLine(value, max);
}

function skillText(documents: SkillDocument[], skill: string): string {
  const found = documents.find((d) => d.skill === skill && d.file === "SKILL.md");
  return found ? found.text : `(The ${skill} skill is not installed on this server; proceed from the tool descriptions.)`;
}

function message(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerSkillPrompts(server: McpServer, documents: SkillDocument[] = getSkillDocuments()): void {
  server.registerPrompt(
    "analyze_ad",
    {
      title: "Analyze one of my ads",
      description: "Full review of a single ad: creative, copy, targeting, performance and what to change.",
      argsSchema: {
        ad_id: z.string().describe("The ad ID to review"),
        date_preset: z.string().optional().describe("Period, e.g. last_7d or last_30d (default last_30d)"),
      },
    },
    ({ ad_id, date_preset }) =>
      message(
        `${skillText(documents, "meta-ads-creative-analysis")}\n\n---\n\nReview ad ${arg(ad_id, 40)} over ${arg(date_preset, 20) || "last_30d"}.\n\n` +
          `Start with ads_get_ad_dossier, which returns the ad, its ad set and campaign, the creative and its copy, the targeting and the performance in one call. Look at the creative itself, not only its JSON. Then give the verdict, the evidence behind it, and two or three testable changes.`,
      ),
  );

  server.registerPrompt(
    "analyze_ad_video",
    {
      title: "Analyze an ad video",
      description: "Watch an ad video and report hook, retention, message and what to change.",
      argsSchema: {
        video_id: z.string().optional().describe("Meta video ID"),
        ad_id: z.string().optional().describe("Ad ID, to resolve its video"),
        dataset_id: z.string().optional().describe("Ad Library dataset ID (with ad_archive_id)"),
        ad_archive_id: z.string().optional().describe("Ad Library ad_archive_id (with dataset_id)"),
        focus: z.string().optional().describe("A specific question to answer about the video"),
      },
    },
    ({ video_id, ad_id, dataset_id, ad_archive_id, focus }) => {
      const source = video_id
        ? `video_id ${arg(video_id, 40)}`
        : ad_id
          ? `ad_id ${arg(ad_id, 40)}`
          : dataset_id && ad_archive_id
            ? `dataset_id ${arg(dataset_id, 40)} with ad_archive_id ${arg(ad_archive_id, 40)}`
            : "(no source given — ask which video to analyze)";
      return message(
        `${skillText(documents, "meta-ads-video-analysis")}\n\n---\n\nAnalyze the ad video for ${source}.\n\n` +
          (focus ? `The team's question: ${arg(focus, 500)}\n\n` : "") +
          `Pick the delivery that matches what you can actually ingest, as the skill describes, before calling anything. Report the hook with a score and the reasoning, where retention breaks if you have the numbers, and the changes worth testing.`,
      );
    },
  );

  server.registerPrompt(
    "competitor_creative_research",
    {
      title: "Research a competitor's ads",
      description: "Scrape the public Meta Ad Library for a page or keyword and report the patterns.",
      argsSchema: {
        query: z.string().optional().describe("Keyword to search the Ad Library for"),
        page_url: z.string().optional().describe("A Facebook page's Ad Library URL"),
        count: z.string().optional().describe("How many ads to scrape (default 30)"),
      },
    },
    ({ query, page_url, count }) =>
      message(
        `${skillText(documents, "meta-ads-competitor-research")}\n\n---\n\nResearch ${query ? `the keyword "${arg(query)}"` : page_url ? `the page ${arg(page_url, 300)}` : "(ask which competitor or keyword)"} in the public Meta Ad Library, about ${arg(count, 10) || "30"} ads.\n\n` +
          `This spends the advertiser's Apify credit, so list existing runs first and reuse a dataset when one fits. Report the patterns across the set — the concepts they keep running, what they test, their offers and the gaps — not a summary of each ad.`,
      ),
  );

  server.registerPrompt(
    "ad_library_ad_deep_dive",
    {
      title: "Break down one Ad Library ad",
      description: "Read a single scraped competitor ad in full, including its media.",
      argsSchema: {
        dataset_id: z.string().describe("Dataset ID from a previous scrape"),
        ad_archive_id: z.string().describe("The ad_archive_id inside that dataset"),
      },
    },
    ({ dataset_id, ad_archive_id }) =>
      message(
        `${skillText(documents, "meta-ads-competitor-research")}\n\n---\n\nBreak down the Ad Library ad ${arg(ad_archive_id, 40)} in dataset ${arg(dataset_id, 40)}.\n\n` +
          `Use ads_library_get_ad_details, passing hint_offset if you know it. Look at the creative. If it is a video, follow the video-analysis skill. Report what the ad promises, how it is built, and what we could test against it.`,
      ),
  );

  server.registerPrompt(
    "creative_performance_review",
    {
      title: "Review creative performance across an account",
      description: "Compare the account's ads over a period and say which creative approach is working.",
      argsSchema: {
        account_id: z.string().describe("Ad account ID"),
        date_preset: z.string().optional().describe("Period, e.g. last_30d"),
      },
    },
    ({ account_id, date_preset }) =>
      message(
        `${skillText(documents, "meta-ads-creative-analysis")}\n\n---\n\nReview creative performance for account ${arg(account_id, 40)} over ${arg(date_preset, 20) || "last_30d"}.\n\n` +
          `Pull ad-level insights, pick the best and worst by cost per result with enough spend behind each to mean something, and look at both creatives. Name the variable that separates them and the test that would confirm it.`,
      ),
  );

  server.registerPrompt(
    "account_health_check",
    {
      title: "Check an account's health",
      description: "Spend, results, delivery problems and anything currently disapproved.",
      argsSchema: {
        account_id: z.string().describe("Ad account ID"),
        date_preset: z.string().optional().describe("Period, e.g. last_7d"),
      },
    },
    ({ account_id, date_preset }) =>
      message(
        `${skillText(documents, "meta-ads-mcp-guide")}\n\n---\n\nCheck the health of account ${arg(account_id, 40)} over ${arg(date_preset, 20) || "last_7d"}.\n\n` +
          `Follow the account snapshot workflow: read the account's currency and status first, then the period's spend and results against the previous one, then the exceptions — disapproved ads, delivery problems, anything spending without results. Lead with what needs attention.`,
      ),
  );
}
