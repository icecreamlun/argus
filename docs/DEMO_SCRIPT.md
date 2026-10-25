# Argus — 90-second demo video script

**Structure:** the numbers (0:00–0:22), why it matters (0:22–0:30), the loop (0:30–1:15), the close (1:15–1:30).
About 240 words. Read at a confident, steady pace.

**Setup:** `cd web && npm run dev`, then open
`http://127.0.0.1:5173/?cam=overview&tod=15&quake=san_andreas_1906&speed=4&air=replay`
(replay mode: the recorded gemini-4-argon run, no waiting, works offline). Record at 1600×900 or larger.

| Time | On screen | Voiceover |
|---|---|---|
| **0:00–0:12** | Cold open on the end state (`&t=760`): the AIR panel's big figures **33% → 43%**, then zoom in on the line *Buildings seen on video: 24% → 55%*. | *"A magnitude 7.8 hits San Francisco. The standard damage model scores thirty-three percent. Twelve minutes later, Argus — powered by Gemini 4 Argon — has the whole city at forty-three, and every building it has seen at fifty-five, up from twenty-four."* |
| **0:12–0:22** | Quick cuts: recon pins *Collapsed · 6 people trapped* → the COMMUNITY REPORTS panel open (198) → the Copilot plan card *36 units · 8 sites*. | *"Along the way it read twenty-six video clips, triaged a hundred and ninety-eight resident reports, confirmed twenty-one collapses, and routed thirty-six rescue units to eight sites."* |
| **0:22–0:30** | Slow push-in over the city at dawn. | *"1976, Tangshan. Two hundred and forty thousand people died. My parents were buried in that rubble, and rescuers didn't know where to look."* |
| **0:30–0:38** | Restart at T+0: the USGS card slides in, the ShakeAlert banner fires, buildings collapse. | *"The moment USGS posts the quake, a physics model of five thousand six hundred real buildings predicts the damage — blind."* |
| **0:38–0:48** | AIR 1 sweeps the city and the grey veil lifts behind it as recon pins appear. Inset: the AR-tagged helicopter frame. | *"A police helicopter streams video, and Argon reads every building — collapses, fires, people on rooftops. Each observation shows how hard that block really shook, so seeing seven percent of the city corrects all of it."* |
| **0:48–0:58** | The Argon plan card types out its rationale → click **Approve** → drones lift off, three live thumbnails. | *"Then Argon finds where it is still blind and proposes drone missions. The commander approves. Twenty close-up orbits later, the picture sharpens again."* |
| **0:58–1:05** | Open COMMUNITY REPORTS: new reports slide in and Argon's verdicts fade in (*Destroyed · 2 trapped · 85%*). | *"Residents report in from their phones. Argon triages every message and discounts the exaggeration and the duplicates."* |
| **1:05–1:15** | Copilot: click the first quick prompt → the answer types out, routes flow around blocked streets with P1–P5 markers → click **Dispatch**: units move and ETAs count down. | *"And the commander simply asks: ten engines, twenty officers, two helicopters — what now? Argon ranks the trapped, routes every unit around blocked streets, and explains why."* |
| **1:15–1:30** | The accuracy chart climbing from 33% to 43% with the W1 and W2 markers, then the ARGUS wordmark over the city at night. | *"Predict, see, correct, decide, act — one loop, Gemini 4 Argon at every step, a human approving every move. Argus: see the city, find the trapped."* |

### Numbers used
From the recorded live run (1906 repeat at 15:00), scored against the simulator's hidden truth.

| Claim in the voiceover | Value |
|---|---|
| Whole core area (1,902 buildings), xBD macro-F1 | 33.4% model alone → 38.8% after the helicopter → **43.2%** at the end |
| Buildings seen on video (121), scored on the same buildings | 23.7% → **55.0%** |
| Video clips read by Argon | 26: 6 helicopter chunks (~20 s each) and 20 drone orbits (~12 s each) |
| Resident reports | 198 triaged; 143 of 186 linked to the right building (77%); damage read correctly on 138 of those 143 (96.5%) |
| Collapses confirmed by Argon | 21 |
| Copilot plan | 36 units to 8 sites |
| Seen by AIR 1 | 43% of the core area; 7% of buildings assessed one by one |

A new live run re-records the replay and changes these numbers. Keep them in sync with the replay you record from.

### Shot tips
- Before recording, set playback to 4× (or use `speed=4` in the URL) so the helicopter pass and both drone waves fit into one take. Then cut it down in editing.
- Best angles: the **Chinatown** preset (`3`) for reconstruction pins, **Overview** (`1`) for drones, and the camera's automatic fly-to when a Copilot plan appears.
- To show the Approve click for real, record that segment in live mode (no `air=replay`). This re-records the replay. Replay mode approves recorded plans on its own.
- Recorded Copilot questions (instant in replay):
  1. *I have 10 fire engines, 20 police officers, 2 helicopters and 6 ambulances. How should I route them, and what are the priorities?*
  2. *How many people are confirmed trapped, and where?*
  3. *Which roads should police clear first?*
  4. *Where should the helicopters go?*
  5. *If Pine Street is cleared, what changes?*

### Optional closing line (roadmap — future tense only)
> *"Next, Argus will listen to 911 calls and news hotlines, and fuse them with what it sees from the air."*

Don't show or imply that call monitoring works today.
