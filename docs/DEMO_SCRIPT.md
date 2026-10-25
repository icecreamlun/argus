# Argus — 2-minute demo video script

**Flow (follows the live demo step by step):** pitch → the city → trigger the quake → the model → Argon + helicopter → drones and residents → Copilot → the numbers and lives.
About 330 words for a fast speaker (~2.8 words per second).

**Setup:** `cd web && npm run dev`, then open
`http://127.0.0.1:5173/?cam=overview&tod=15&air=replay`
(replay mode: the recorded gemini-4-argon run plays back instantly and works offline). Record at 1600×900 or larger at 4× playback, and trim in editing.

| Time | On screen (what you do) | Voiceover |
|---|---|---|
| **0:00–0:10** | Black, then a slow push-in over the city. | *"My parents were trapped in the 1976 Tangshan earthquake, and rescuers didn't know where to dig. Argus uses Gemini 4 Argon to tell them — in the first hour, building by building."* |
| **0:10–0:28** | Orbit the overview, fly to the Ferry Building (`2`) and Chinatown (`3`), drag the time slider to dusk. | *"This is San Francisco, from the Ferry Building to Chinatown, rebuilt one-to-one from real data: nearly fifty-seven hundred buildings from OpenStreetMap, heights from the city's LiDAR survey, and year built and construction type from the assessor's records — plus every street, every street tree and the real terrain. Each building knows how it was built and how many people are inside."* |
| **0:28–0:44** | Click **Simulate** on *San Andreas M7.8 — 1906 repeat*: the USGS card, the ShakeAlert banner, waves sweeping in, buildings swaying and collapsing. | *"Now I trigger a repeat of 1906 — magnitude 7.8, fourteen kilometres out. The event arrives in USGS format and ShakeAlert fires, but we're in the blind zone. Shaking is computed from fault distance and soil, every building sways at its own period, and the old brick comes down."* |
| **0:44–0:58** | Toggle the **ShakeMap** overlay, then **Damage**. Point at the AIR panel's model figure. | *"Within minutes an operations centre has a model: FEMA's HAZUS curves turn shaking into damage odds for every building. But it's blind. It calls almost everything 'major damage' and can't tell which building stood. On the xBD damage scale it scores thirty-three percent."* |
| **0:58–1:16** | AIR 1 sweeps in and the grey veil lifts behind it. Show the AR-tagged helicopter frame, then the recon pins appearing. | *"So Argus sends a police helicopter. Its address-tagged video streams to Gemini 4 Argon, which reconstructs every building it sees — collapses, fires, people on rooftops — in about twenty seconds a clip. Shaking is spatially correlated, so each observation corrects the model around it: seeing seven percent of the city sharpens all of it."* |
| **1:16–1:30** | The Argon plan card → click **Approve** → drones lift off with live thumbnails. Then open COMMUNITY REPORTS. | *"Then Argon finds where it's still blind and proposes drone missions. I approve, and twenty close-up orbits follow. Meanwhile residents report from their phones; Argon triaged a hundred and ninety-eight messages and matched seventy-seven percent to the right building."* |
| **1:30–1:42** | Open Copilot (`C`) and click the first quick prompt. Routes flow around blocked streets with P1–P5 markers → click **Dispatch**. | *"Finally I just ask: ten engines, twenty officers, two helicopters — what now? Argon ranks the trapped, routes every unit around blocked streets, and I dispatch."* |
| **1:42–2:00** | The AIR panel **33% → 43%** with the chart climbing, then the *24% → 55%* line, then the ARGUS wordmark. | *"The result: the model alone, thirty-three percent. Corrected by Argon, forty-three for the whole city, and fifty-five on every building it saw — more than double. And Argon's eight rescue sites hold twenty-one trapped survivors; the model's top eight held ten. Same crews, twice the people within reach. That's Argus."* |

### Numbers used
From the recorded live run (1906 repeat at 15:00), scored against the simulator's hidden truth.

| Claim | Value |
|---|---|
| Buildings | 5,689 (OSM footprints; 1,550 with DataSF LiDAR heights; 4,784 with assessor year built and construction type), 3,730 streets, 7,777 street trees |
| Quake | M7.8, epicentre 14 km WSW; ShakeAlert warning arrives after the shaking (blind zone) |
| Whole core area (1,902 buildings), xBD macro-F1 | 33.4% model alone → 38.8% after the helicopter → **43.2%** at the end |
| Buildings seen on video (121), scored on the same buildings | 23.7% → **55.0%** |
| Video clips read by Argon | 6 helicopter chunks (~20 s each) and 20 drone orbits (~12 s each) |
| Resident reports | 198 triaged; 143 of 186 linked to the right building (77%); damage read correctly on 96.5% of those |
| Trapped survivors at the Copilot's 8 sites vs the model's top 8 sites | **21 vs 10** (model ranking = P(complete damage) × daytime occupants; same number of sites) |

A new live run re-records the replay and changes these numbers. Keep them in sync with the replay you record from.

### Shot tips
- Record at 4× (`speed=4` or the playback button) so the helicopter pass and both drone waves fit into one take. Then trim in editing.
- Best angles: **Chinatown** (`3`) for reconstruction pins, **Overview** (`1`) for drones, and the automatic fly-to when a Copilot plan appears.
- In replay mode the recorded plans are approved on their own. To click **Approve** on camera, record that part in live mode (no `air=replay`). Note that this re-records the replay.
- Recorded Copilot questions (instant in replay): *I have 10 fire engines, 20 police officers, 2 helicopters and 6 ambulances. How should I route them, and what are the priorities?* · *How many people are confirmed trapped, and where?* · *Which roads should police clear first?* · *Where should the helicopters go?* · *If Pine Street is cleared, what changes?*

### Optional closing line (roadmap — future tense only)
> *"Next, Argus will listen to 911 calls and news hotlines, and fuse them with what it sees from the air."*

Don't show or imply that call monitoring works today.
