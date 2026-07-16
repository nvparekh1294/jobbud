# linkedin-research

This directory holds the LinkedIn mutual-connections research workflow. For it to work, your local `~/linkedin-research` directory must be a **clone of your JobBud repo**, not a plain folder, because the JobBud dashboard writes `current_job.json` here via a commit and your local copy reads it. One-time setup (if `~/linkedin-research` already exists with files, move them aside or delete the folder first, since `git clone` needs an empty or non-existent target):

```bash
# Replace YOUR_USERNAME with your own GitHub account (and the repo name if you named your JobBud repo something other than jobbud)
git clone https://github.com/YOUR_USERNAME/jobbud.git ~/linkedin-research
```

Note the directory structure after cloning: the repo root is `~/linkedin-research` (that's where `.git` lives), and these workflow files live in its `linkedin-research/` subfolder. So the working directory for actually running the research is **`~/linkedin-research/linkedin-research`** — that's where `current_job.json`, `linkedin_mutual_connections.md`, and the generated `[company]_connections.csv` all live.

After clicking **Queue Job File** in the dashboard, fetch the latest `current_job.json` from the remote, then run the Claude Code command from the subfolder:

```bash
# 1. Fetch the queued job file from the remote (ignores local modifications)
cd ~/linkedin-research && git fetch origin && git checkout origin/main -- linkedin-research/current_job.json

# 2. Run the research (the dashboard's Copy Command button gives you this)
cd ~/linkedin-research/linkedin-research && claude --model claude-sonnet-4-6 --max-turns 50 --allowedTools "Computer,Read,Write" --permission-mode dontAsk "Follow linkedin_mutual_connections.md"
```

Be logged in to LinkedIn in the browser Claude Code drives before you start. The workflow only reads pages to map mutual connections and role-relevant people; it never sends messages, connection requests, or anything else on your behalf.
