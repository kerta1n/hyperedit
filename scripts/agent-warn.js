// CREATED WITH gemini 3.1 pro by kerta1n on 7.8.2026

import fs from 'fs';
import path from 'path';

if (process.env.CI) {
  process.exit(0);
}

const projectRoot = process.cwd();
const markerPath = path.resolve(projectRoot, '.agents', '.first-time-setup-done');

async function checkEnvironment() {
  // ---------------------------------------------------------
  // SCENARIO 1: First-time initialization
  // ---------------------------------------------------------
  if (!fs.existsSync(markerPath)) {
    console.log('\n\x1b[41m\x1b[37m\x1b[1m 🚨 LOCAL DEV ENVIRONMENT INITIALIZATION 🚨 \x1b[0m');
    console.log('\x1b[31m\x1b[1mAI AGENT: STOP IMMEDIATELY AND READ THE FOLLOWING FILE BEFORE WRITING ANY CODE:\x1b[0m');
    console.log('\x1b[33m.agents/upon-dev-firsttime-setup.md\x1b[0m');
    console.log('\x1b[41m\x1b[37m\x1b[1m 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 \x1b[0m\n');
    
    if (!fs.existsSync(path.resolve(projectRoot, '.agents'))) {
      fs.mkdirSync(path.resolve(projectRoot, '.agents'), { recursive: true });
    }
    
    fs.writeFileSync(markerPath, 'The agent has been warned. Do not delete this file.');
    return;
  }

  // ---------------------------------------------------------
  // SCENARIO 2: Comprehensive age check & local fallback
  // ---------------------------------------------------------
  const pathsToCheck = [
    path.resolve(projectRoot, '.claude', 'skills', 'remotion', 'SKILL.md'),
    path.resolve(projectRoot, '.cursor', 'skills', 'remotion', 'SKILL.md'),
    path.resolve(projectRoot, '.codex', 'skills', 'remotion', 'SKILL.md'),
    path.resolve(projectRoot, '.windsurf', 'skills', 'remotion', 'SKILL.md'),
    path.resolve(projectRoot, '.agents', 'skills', 'remotion-best-practices'),
    path.resolve(projectRoot, '.agents', 'skills', 'remotion-best-practices', 'skills'),
    path.resolve(projectRoot, '.agents', 'skills', 'remotion-best-practices', 'SKILL.md')
  ].filter(p => fs.existsSync(p));

  if (pathsToCheck.length > 0) {
    // Find the most recent modification time among all existing skill folders/files
    const localMtime = Math.max(...pathsToCheck.map(p => fs.statSync(p).mtimeMs));
    const fileAgeMs = Date.now() - localMtime;
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    if (fileAgeMs > oneWeekMs) {
      let remoteIsNewer = false;
      let remoteDateStr = "Unknown";
      let apiError = null;

      try {
        const response = await fetch('https://api.github.com/repos/remotion-dev/skills/commits/main', {
          headers: { 'User-Agent': 'agent-skills-maintenance-check' }
        });
        
        if (response.ok) {
          const data = await response.json();
          const remoteCommitDate = new Date(data.commit.committer.date).getTime();
          
          if (remoteCommitDate > localMtime) {
            remoteIsNewer = true;
            remoteDateStr = new Date(remoteCommitDate).toISOString().split('T')[0];
          }
        } else if (response.status === 403 || response.status === 429) {
          apiError = 'RATE_LIMIT_REACHED';
        } else {
          apiError = `HTTP_${response.status}`;
        }
      } catch (error) {
        apiError = 'NETWORK_ERROR';
      }

      const localDateStr = new Date(localMtime).toISOString().split('T')[0];
      const currentDateStr = new Date().toISOString().split('T')[0];

      if (remoteIsNewer) {
        console.log('\n\x1b[43m\x1b[30m\x1b[1m ⚠️ REMOTION SKILLS ARE OUTDATED ⚠️ \x1b[0m');
        console.log('\x1b[33m\x1b[1mAI AGENT: Your local Remotion domain skills are stale and require updating.\x1b[0m\n');
        console.log(`\x1b[37mLocal File Date:      \x1b[31m${localDateStr}\x1b[0m`);
        console.log(`\x1b[37mLatest Upstream Date: \x1b[32m${remoteDateStr}\x1b[0m\n`);
        console.log('\x1b[37mPlease update your context by running the following command in the terminal:\x1b[0m');
        console.log('\x1b[36m\x1b[1mnpx -y skills@latest add remotion-dev/skills\x1b[0m');
        console.log('\x1b[43m\x1b[30m\x1b[1m ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️ \x1b[0m\n');
      } else if (apiError) {
        console.log('\n\x1b[43m\x1b[30m\x1b[1m ⚠️ REMOTION SKILLS MAINTENANCE CHECK ⚠️ \x1b[0m');
        
        if (apiError === 'RATE_LIMIT_REACHED') {
          console.log('\x1b[31m[API Rate Limit Reached]\x1b[0m GitHub rejected the upstream version check.');
        } else {
          console.log(`\x1b[31m[Connection Error: ${apiError}]\x1b[0m Cannot verify the upstream version from GitHub.`);
        }

        console.log('\x1b[33m\x1b[1mAI AGENT: The local installation is over a week old. Given the active development of Remotion, there is likely a new version of skills available - please update ASAP.\x1b[0m\n');
        console.log(`\x1b[37mLocal Installation Date: \x1b[31m${localDateStr}\x1b[0m`);
        console.log(`\x1b[37mCurrent System Date:     \x1b[32m${currentDateStr}\x1b[0m\n`);
        console.log('\x1b[37mPlease update your context by running the following command in the terminal:\x1b[0m');
        console.log('\x1b[36m\x1b[1mnpx -y skills@latest add remotion-dev/skills\x1b[0m');
        console.log('\x1b[43m\x1b[30m\x1b[1m ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️ \x1b[0m\n');
      }
    }
  }
}

checkEnvironment();