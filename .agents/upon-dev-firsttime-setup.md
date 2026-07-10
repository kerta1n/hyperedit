# 🚨 FIRST-TIME AGENT INITIALIZATION 🚨

Hello! If you are reading this, you have just been initialized in this repository and triggered the local development warning. Before we write any code or start debugging, you **must** execute the following setup steps in exact order to configure your context.

## Step 1: Fetch Domain Skills
This project relies heavily on Remotion. You need the latest best-practice rules to avoid writing deprecated code.
* **Action:** Open the terminal and run the official Remotion skills CLI: `npx -y skills@latest add remotion-dev/skills`

## Step 2: Ingest Domain Knowledge
Now that the skills are downloaded, you need to load them into your context window.
* **Action:** Locate the downloaded `SKILL.md` file (it will typically install into `.claude/skills/remotion/SKILL.md`, `.cursor/skills/remotion/SKILL.md` or whatever agent folder depending on your environment) and read it. Take note of the architectural rules.

## Step 3: Final Confirmation
Do not begin modifying application code until these steps are complete. 
* **Action:** Reply to the human developer with a brief, friendly confirmation that you have successfully fetched the Remotion skills. Ask them if they want to check if all of the necessary node_modules, as well if the according whisper implementation is correctly installed, or what they would like to work on first.