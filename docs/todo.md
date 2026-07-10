# HyperEdit - Product Roadmap

## Current State (What's Built)
- [x] Multi-track timeline (V1 base, V2 overlays)
- [x] Asset library with drag-and-drop
- [x] Video preview with layered compositing
- [x] AI auto-GIF workflow (transcribe → extract keywords → fetch GIFs → auto-place)
- [x] FFmpeg video processing
- [x] Dead air/silence removal
- [x] Chapter generation
- [x] Clip move, resize, delete
- [x] Basic export functionality
- [x] **Motion Graphics (Remotion)** - Animated text, lower thirds, CTAs

## Ship Now (MVP) - Do These First
These are blockers for getting real users:

- [ ] **Add API key setup UI** - Users need to add OPENAI_API_KEY and GIPHY_API_KEY
  - Either: settings modal, or .env file instructions, or proxy through your backend
- [ ] **Test the full export flow** - Ensure rendered video actually works
- [ ] **Add a landing page** - Even a simple one explaining what it does
- [ ] **Deploy somewhere** - Vercel/Railway for frontend, need solution for FFmpeg backend

## Nice-to-Have (Post-Launch)
Don't build these until you have users asking for them:

- [ ] Undo/redo
- [ ] More AI edit commands (speed up, add music, auto-captions)
- [ ] Custom keyword lists for GIF extraction
- [ ] GIF position/size controls in preview
- [ ] Audio track visualization
- [ ] Keyboard shortcuts
- [ ] Project save/load to cloud
- [ ] User accounts
- [ ] More export formats/quality options

## Known Issues
- [ ] Moving clips can cause preview to briefly show wrong content
- [ ] No undo after clip operations
- [ ] Large videos may be slow to process

## Future Ideas (Parking Lot)
- Auto-captions with styling
- B-roll suggestion and insertion
- Music matching to video mood
- Social media format presets (9:16, 1:1)
- Direct publish to YouTube/TikTok
- Collaboration features



# Todo
- #1: Add backend FFmpeg processing and R2 file storage
- #2: Connect UI to backend video processing for actual video editing


<!-- todos by kerta1n start -->
known issues:
(Mocha removal, Cloudflare removal, v1 transitions, clipwise refs, ffmpeg-server split, whisper/MPS, /tmp hardcoding, undo/redo, homelab latency, WebCodecs memory, playback sync per `V2_OVERLAY_SYNC_INVESTIGATION.md`)

other issues:

# need to consider how proxy clips can speed up hyperedit (may somewhat fix the homelab deployment scenario)
compressing on import (meaning the clips that get used during render) doesnt matter as much, but still another option that can be thought about
# ffmpeg server ALLOW for cancelling video render (and make sure it doesnt crash, otherwise will keep a core pinned at 100% on my windows system)
is the hardcoded (something) 4 related to it, and can it crash if the CONCURRENCY value is different?
# REUSE files inside "bundles" and "temp" folders, storage accumulating WAY too quickly (ram)
also perform another sweep of functions to make sure no other functions are leaking out to default paths either if not defined
manage and re-use cached puppeteer profiles
# pipe errors back into "chat" style rather than the website message
specifically render, 118000ms timeout issue, maybe failed to allocate (also need to address this later)
# migrate captions to using actual ass files?
# can't drag clip on v1 to other v tracks, only works left right slide on same track
# clip properties dont apply to v1 (e.g. the rotate, zoom etc)
this may be due to code structure making hyperedit center around v1 instead of track agnostic architecture
# add precise timestamp to duration in editor bar
could allow user to choose timestamp of where to insert transition
# make hyperedit agent friendly (hermes or openclaw) so that video can be edited THROUGH hyperedit without needing to look at it
this would require features like headless snapshot or even video clips of any decisions the agent would want to pass back to the operator to allow them to view (say via telegram, so hermes would be interacting with a deployment of hyperedit, and if the agent wants the person to make a decision between a & b, it can ask hyperedit custom render an area of a video incl choosing which tracks, effects, transitions, captions etc)
also require adding efficient way to allow agents that have vision-capable models to also SEE the actual videos (e.g. gemma 4) and truly understand the video. not sure the best way to execute this, will need advising from claude
regarding the actual controlling mechanism, what is best (but ideally the most EFFICIENT, espec for token/ctx bloat and overhead) for the actual bridge between the agent and hyperedit? skills+api, mcp, both, or something else entirely (but that most tools like even claude code are starting to adopt)? i want this to be as accesible to automate as possible, and the reason why i still take token & ctx efficiency into consideration is so that hyperedit can be driven by smaller models like mentioned with gemma4, but also qwen3.6, etc which may be even powering hermes, are being used as the model for subagents, etc (local llm models should be able to have the same experience automating their video editing as people who are ok with paying for ai subs as possible).
<!-- todos by kerta1n start --->