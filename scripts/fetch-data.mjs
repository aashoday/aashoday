// Pulls live data from the GitHub GraphQL API and writes docs/data.json.
// Needs Node 20+. Env: GH_TOKEN (required), GH_USER (optional, defaults to repo owner).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const login = process.env.GH_USER || 'aashoday';
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is missing.');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-dashboard'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

const PROFILE = `
query($login: String!) {
  user(login: $login) {
    login name avatarUrl url bio createdAt
    followers { totalCount }
    following { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100,
                 orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      nodes {
        name description url stargazerCount forkCount pushedAt
        primaryLanguage { name color }
        languages(first: 8, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
    pinnedItems(first: 6, types: REPOSITORY) {
      nodes {
        ... on Repository {
          name description url stargazerCount forkCount pushedAt
          primaryLanguage { name color }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const OSS = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    issueCount
    nodes {
      ... on PullRequest {
        title url mergedAt additions deletions
        repository { nameWithOwner url stargazerCount }
      }
    }
  }
}`;

const [{ user }, ossData] = await Promise.all([
  gql(PROFILE, { login }),
  gql(OSS, { q: `is:pr is:merged author:${login} -user:${login} sort:updated-desc` })
]);

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const hidden = new Set(config.hideLanguages || ['Jupyter Notebook']);

// Repos (skip the profile repo itself)
const repos = user.repositories.nodes.filter((r) => r.name !== login);
const stars = repos.reduce((n, r) => n + r.stargazerCount, 0);

// Language totals by bytes across all owned repos
const langBytes = new Map();
for (const r of repos) {
  for (const e of r.languages.edges) {
    if (hidden.has(e.node.name)) continue;
    const cur = langBytes.get(e.node.name) || { name: e.node.name, color: e.node.color, bytes: 0 };
    cur.bytes += e.size;
    langBytes.set(e.node.name, cur);
  }
}
const totalBytes = [...langBytes.values()].reduce((n, l) => n + l.bytes, 0) || 1;
const languages = [...langBytes.values()]
  .sort((a, b) => b.bytes - a.bytes)
  .map((l) => ({ ...l, pct: (l.bytes / totalBytes) * 100 }));

// Projects: pinned first, otherwise top repos by stars
const slim = (r) => ({
  name: r.name,
  description: r.description,
  url: r.url,
  stars: r.stargazerCount,
  forks: r.forkCount,
  pushedAt: r.pushedAt,
  language: r.primaryLanguage && !hidden.has(r.primaryLanguage.name) ? r.primaryLanguage : null
});
let pinned = user.pinnedItems.nodes.filter(Boolean).map(slim);
if (!pinned.length) {
  pinned = [...repos]
    .sort((a, b) => b.stargazerCount - a.stargazerCount)
    .slice(0, 4)
    .map(slim);
}

// Open source: merged PRs in other people's repos, biggest repos first
const prs = ossData.search.nodes.filter(Boolean);
const ossItems = prs
  .map((p) => ({
    title: p.title,
    url: p.url,
    mergedAt: p.mergedAt,
    repo: p.repository.nameWithOwner,
    repoUrl: p.repository.url,
    stars: p.repository.stargazerCount,
    additions: p.additions,
    deletions: p.deletions
  }))
  .sort((a, b) => b.stars - a.stars || new Date(b.mergedAt) - new Date(a.mergedAt))
  .slice(0, 8);

const cc = user.contributionsCollection;
const data = {
  // Date only, so the file (and screenshots) don't change unless the data does.
  generatedAt: new Date().toISOString().slice(0, 10),
  user: {
    login: user.login,
    name: user.name,
    avatar: user.avatarUrl,
    url: user.url,
    bio: user.bio,
    followers: user.followers.totalCount,
    following: user.following.totalCount,
    createdAt: user.createdAt
  },
  stats: {
    publicRepos: user.repositories.totalCount,
    stars,
    contributions: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions,
    prs: cc.totalPullRequestContributions,
    reviews: cc.totalPullRequestReviewContributions,
    issues: cc.totalIssueContributions
  },
  oss: {
    total: ossData.search.issueCount,
    repos: new Set(prs.map((p) => p.repository.nameWithOwner)).size,
    items: ossItems
  },
  pinned,
  languages,
  calendar: cc.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount }))
  ),
  config
};

await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/data.json', import.meta.url), JSON.stringify(data, null, 2));
console.log(`Wrote docs/data.json for ${login}: ${data.oss.total} external merged PRs, ${stars} stars.`);
