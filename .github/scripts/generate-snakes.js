import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const user = process.env.GITHUB_USER || "alialipourdev";
const years = (process.env.SNAKE_YEARS || "2024,2025,2026")
  .split(",")
  .map((year) => Number(year.trim()))
  .filter((year) => Number.isInteger(year));
const snkRoot = process.env.SNK_ROOT;
const outDir = path.resolve(process.env.OUTPUT_DIR || "dist");
const token = process.env.GITHUB_TOKEN || "";

if (!snkRoot) {
  console.error("SNK_ROOT is required");
  process.exit(1);
}

const fileUrl = (relativePath) =>
  pathToFileURL(path.join(snkRoot, relativePath)).href;

const { cellsToGrid } = await import(
  fileUrl("packages/generate-snake-animation/cellsToGrid.ts")
);
const { getBestRoute } = await import(fileUrl("packages/solver/getBestRoute.ts"));
const { getPathToPose } = await import(
  fileUrl("packages/solver/getPathToPose.ts")
);
const { snake4 } = await import(
  fileUrl("packages/types/__fixtures__/snake.ts")
);
const { createSvg } = await import(fileUrl("packages/svg-creator/index.ts"));

const light = {
  sizeDotBorderRadius: 2,
  sizeCell: 16,
  sizeDot: 12,
  colorDotBorder: "#11111114",
  colorEmpty: "#f4f4f5",
  colorDots: ["#f4f4f5", "#d9f99d", "#a3e635", "#65a30d", "#3f6212"],
  colorSnake: "#111111",
};

const dark = {
  sizeDotBorderRadius: 2,
  sizeCell: 16,
  sizeDot: 12,
  colorDotBorder: "#ffffff14",
  colorEmpty: "#161616",
  colorDots: ["#161616", "#1a2e05", "#3f6212", "#65a30d", "#a3e635"],
  colorSnake: "#a3e635",
};

const query = /* GraphQL */ `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              contributionLevel
              weekday
              date
            }
          }
        }
      }
    }
  }
`;

const levelFromName = (level) =>
  (level === "FOURTH_QUARTILE" && 4) ||
  (level === "THIRD_QUARTILE" && 3) ||
  (level === "SECOND_QUARTILE" && 2) ||
  (level === "FIRST_QUARTILE" && 1) ||
  0;

const yearWindow = (year, shortenByDays = 0) => {
  const from = new Date(Date.UTC(year, 0, 1));
  const fullEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const shortened = new Date(fullEnd.getTime() - shortenByDays * 86400000);
  const latestAllowed = new Date(Date.now() - 60 * 1000);
  const to = shortened > latestAllowed ? latestAllowed : shortened;
  return { from: from.toISOString(), to: to.toISOString() };
};

const fetchGraphql = async (from, to) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "alialipourdev-readme",
    },
    body: JSON.stringify({ query, variables: { login: user, from, to } }),
  });

  const body = await response.json();
  if (!response.ok || body.errors) {
    const message = body.errors?.map((error) => error.message).join("; ");
    throw new Error(message || response.statusText);
  }

  const calendar = body.data.user.contributionsCollection.contributionCalendar;
  const cells = calendar.weeks.flatMap(({ contributionDays }, x) =>
    contributionDays.map((day) => ({
      x,
      y: day.weekday,
      date: day.date,
      count: day.contributionCount,
      level: levelFromName(day.contributionLevel),
    })),
  );

  return { cells, total: calendar.totalContributions };
};

const fetchPublicYear = async (year) => {
  const response = await fetch(
    `https://github-contributions-api.jogruber.de/v4/${user}?y=${year}`,
    { headers: { "User-Agent": "alialipourdev-readme" } },
  );
  if (!response.ok) {
    throw new Error(`Public contribution API failed (${response.status})`);
  }

  const body = await response.json();
  const days = body.contributions
    .filter((day) => day.date.startsWith(`${year}-`))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (days.length === 0) return { cells: [], total: 0 };

  const first = new Date(`${days[0].date}T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const cells = days.map((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const diffDays = Math.round((date - start) / 86400000);
    return {
      x: Math.floor(diffDays / 7),
      y: date.getUTCDay(),
      date: day.date,
      count: day.count,
      level: day.level,
    };
  });

  return { cells, total: body.total?.[String(year)] ?? 0 };
};

const fetchYear = async (year) => {
  if (token) {
    for (const shortenByDays of [0, 1, 2]) {
      const { from, to } = yearWindow(year, shortenByDays);
      try {
        const result = await fetchGraphql(from, to);
        console.log(
          `${year}: ${result.total} contributions via GitHub API (${from} → ${to})`,
        );
        return result;
      } catch (error) {
        console.warn(`${year}: GitHub API attempt failed (${error.message})`);
      }
    }
  }

  const result = await fetchPublicYear(year);
  console.log(`${year}: ${result.total} contributions via public calendar`);
  return result;
};

const buildRoute = (cells) => {
  const grid = cellsToGrid(cells);
  const chain = getBestRoute(grid, snake4);
  chain.push(...(getPathToPose(chain.at(-1), snake4) ?? []));
  return { grid, chain };
};

const renderSvg = (cells, route, drawOptions) =>
  createSvg(route.grid, cells, route.chain, drawOptions, {
    stepDurationMs: 120,
  });

fs.mkdirSync(outDir, { recursive: true });

const written = [];

for (const year of years) {
  const { cells } = await fetchYear(year);
  if (cells.length === 0) {
    throw new Error(`No contribution cells returned for ${year}`);
  }

  const route = buildRoute(cells);
  const lightSvg = renderSvg(cells, route, light);
  const darkSvg = renderSvg(cells, route, dark);
  const lightName = `github-snake-${year}.svg`;
  const darkName = `github-snake-${year}-dark.svg`;

  fs.writeFileSync(path.join(outDir, lightName), lightSvg);
  fs.writeFileSync(path.join(outDir, darkName), darkSvg);
  written.push(lightName, darkName);

  if (year === years.at(-1)) {
    fs.writeFileSync(path.join(outDir, "github-snake.svg"), lightSvg);
    fs.writeFileSync(path.join(outDir, "github-snake-dark.svg"), darkSvg);
    written.push("github-snake.svg", "github-snake-dark.svg");
  }
}

console.log(`Wrote ${written.length} files to ${outDir}`);
