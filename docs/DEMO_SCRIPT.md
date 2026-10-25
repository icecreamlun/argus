# Argus — 2-minute demo video script

**Flow (follows the live demo step by step):** pitch → the city → trigger the quake → the model → Argon watches the helicopter feed and resident reports → Argon's drone patrol plan → Copilot → the numbers and lives.
About 350 words for a fast speaker (~2.9 words per second).

**Setup:** `cd web && npm run dev`, then open
`http://127.0.0.1:5173/?cam=overview&tod=15&air=replay`
(replay mode: the recorded gemini-4-argon run plays back instantly and works offline). Record at 1600×900 or larger at 4× playback, and trim in editing.

| Time | On screen (what you do) | Voiceover |
|---|---|---|
| **0:00–0:09** | Black, then a slow push-in over the city. | *"My parents were trapped in the 1976 Tangshan earthquake, and rescuers didn't know where to dig. Argus uses Gemini 4 Argon to tell them — in the first hour, building by building."* |
| **0:09–0:24** | Orbit the overview, fly to the Ferry Building (`2`) and Chinatown (`3`), drag the time slider to dusk. | *"This is San Francisco, Ferry Building to Chinatown, rebuilt one-to-one from real data: nearly fifty-seven hundred buildings from OpenStreetMap, heights from the city's LiDAR survey, year and construction type from the assessor's records. Each building knows how it was built and who's inside."* |
| **0:24–0:38** | Click **Simulate** on *San Andreas M7.8 — 1906 repeat*: the USGS card, the ShakeAlert banner, waves sweeping in, buildings swaying and collapsing. | *"I trigger a repeat of 1906 — magnitude 7.8, fourteen kilometres out. The event arrives in USGS format, ShakeAlert fires too late, and shaking computed from fault distance and soil brings the old brick down."* |
| **0:38–0:50** | Toggle the **ShakeMap** overlay, then **Damage**. Point at the AIR panel's model figure. | *"Within minutes, FEMA's HAZUS model turns that shaking into damage odds for every building. But it's blind — it calls almost everything 'major damage'. Thirty-three percent on the xBD scale."* |
| **0:50–1:12** | AIR 1 sweeps the city and the grey veil lifts behind it; show the AR-tagged helicopter frame and the recon pins appearing, then open COMMUNITY REPORTS as reports slide in. | *"Then Gemini 4 Argon starts watching everything coming in: the police helicopter's video and the residents' reports. It reads the footage in three dimensions — tying every rooftop to an address and telling a standing tower from a pancaked one — and triages a hundred and ninety-eight resident messages, matching seventy-seven percent to the right building. Each observation corrects the model around it: seeing seven percent of the city sharpens all of it."* |
| **1:12–1:30** | The Argon plan card → click **Approve** → drones climb out along their 3D paths and orbit their targets, with live thumbnails. | *"Based on all of it, Argon finds where it's still blind and proposes a drone patrol plan. It picks the targets and their order; Argus flies them as 3D paths that climb over every tower in the way and orbit each building with the camera locked on. I approve — twenty close-up orbits."* |
| **1:30–1:46** | Open Copilot (`C`), click the first quick prompt. The camera flies to the plan: routes thread around collapsed blocks, helicopter arcs, P1–P5 markers → click **Dispatch**. | *"Then I ask: ten engines, twenty officers, two helicopters — what now? Argon ranks the trapped, and on the 3D map every route threads around collapsed buildings and blocked streets, while helicopters fly straight to rooftops no truck can reach. Dispatch."* |
| **1:46–2:00** | The AIR panel **33% → 43%** with the chart climbing, then the *24% → 55%* line, then the ARGUS wordmark. | *"Model alone: thirty-three percent. With Argon: forty-three citywide, and fifty-five on every building it saw. Argon's eight rescue sites hold twenty-one trapped survivors — the model's top eight held ten. Same crews, twice the lives within reach. That's Argus."* |

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
| 3D paths | Argon chooses drone targets and their order; Argus computes each 3D flight path (cruise altitude above the tallest roof within 60 m, orbits with the camera locked on the target) and each road route (shortest time on the street graph, avoiding verified-blocked segments; helicopters fly direct arcs) |
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
