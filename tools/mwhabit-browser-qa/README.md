# MWHABIT isolated Claude Code Chrome QA runner (Issue #221, scenario #219)

STATUS: SOURCE ONLY. Mac install, Chrome execution, ntfy delivery and actual DEV browser PASS are NOT verified.

Separate from tools/mwhabit-dev-agent. Does not change its Bash/MCP deny rules, label, cost limit, lock, or kill switch. Only #219, owner sonjw222, OPEN, and ai-browser-qa-approved are eligible. Issue body is never used as command or Claude prompt. Execution defaults OFF and is limited to localhost:3199 with an explicitly approved non-production Supabase project reference. No SQL, payment, production login, reservations or PR merge.

Claude CLI: claude -p --chrome. The prompt and CLI restrict tools to Chrome MCP tools and ToolSearch/Skill; budget $1 for each flag, 20 min each. Both feature flag ON and OFF get separate DEV servers. Browser evidence tools and all checklist answers are required before PASS_REPORTED (this is NOT automatic merge approval).

FIRST TIME ON THE MAC (manual actions required):
1. In a graphical Mac login session run claude --chrome, install/enable Claude in Chrome extension, authenticate with claude.ai login (not API key/setup-token), and approve DEV localhost site. Use /chrome to check Enabled and Installed.
2. Ensure this branch's source is installed in the Mac checkout and npm ci is done. Ensure DEV-only .env.test.local has NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY, chmod 600 .env.test.local. Existing production env is not an acceptable target.
3. Create private file at ~/Documents/mwhabit-automation/browser-qa/browser-qa.env and chmod 600. Its lines are:
   MWHABIT_BROWSER_QA_ENABLED=0
   MWHABIT_QA_CHROME_APPROVED=0
   QA_DEV_PROJECT_REF=YOUR_DEV_PROJECT_REF
   NTFY_TOPIC=YOUR_PRIVATE_TOPIC
   NTFY_TOKEN=YOUR_NTFY_TOKEN
   NEVER commit this file, credentials or screenshots.
4. Dry-run: python3 tools/mwhabit-browser-qa/qa_chrome.py
5. Offline tests: python3 -m unittest discover -s tools/mwhabit-browser-qa/tests
6. Only after DEV login/Chrome/site permissions approved: set both MWHABIT_BROWSER_QA_ENABLED=1 and MWHABIT_QA_CHROME_APPROVED=1. Grant ai-browser-qa-approved label to #219. Execute: python3 tools/mwhabit-browser-qa/qa_chrome.py --execute
7. Results in local ~/Documents/mwhabit-automation/browser-qa/issue-219.json and sanitized Issue #219 comment; ntfy STARTED and terminal statuses only when configured. Failed/blocked retry: --execute --force.

Kill switch: touch ~/Documents/mwhabit-automation/browser-qa/BROWSER_QA_DISABLED
The Mac LaunchAgent for scheduled execution is NOT installed by this GitHub PR. Adding code to GitHub cannot start a Chrome process on the user's Mac. If Chrome integration prompts for approval or the DEV admin is not already authenticated, the run must BLOCK and never claim PASS.

SQL execution needed: NO. SQL files/path/order/full text: None. Verification: offline tests, actual Mac status file and Issue #219 evidence after owner-side Chrome activation.
