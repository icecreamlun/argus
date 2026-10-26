# Argus — 3-minute live pitch (no slides)

**Shape:** Tangshan → the problem and the user (0:00–0:30) → live demo step by step (0:30–2:35) → results and lives (2:35–2:50) → why only Argon (2:50–3:00).
About 500 words for a fast speaker. Every line is spoken over the live app.

**Before you go on stage**
- `cd web && npm run dev`; open `http://127.0.0.1:5173/?cam=overview&tod=15&air=replay&speed=4` (it shows the recorded live gemini-4-argon run, so the stage Wi-Fi can't break it).
- Keep a second tab on the end state: `…&quake=san_andreas_1906&t=760&air=replay`.
- Do **one thing live** to prove it is real: type a fresh Copilot question at 2:05 (it calls gemini-4-argon, ~20 s, so keep talking over it). Say out loud which parts are the recorded run.
- The *808 Grant* callback at 2:05 matches the recorded answer (P3: 808 Grant Ave, collapsed with fire). A freshly typed question can rank differently. If 808 Grant isn't in the plan, skip that half-sentence, or click the first quick prompt instead, which plays the recorded answer.

| Time | Do this | Say this |
|---|---|---|
| **0:00–0:15** | Stand still; the city at dawn fills the screen. | *"July 28th, 1976. Tangshan, China. A magnitude 7.8 earthquake at 3:42 in the morning. Two hundred and forty thousand people died. Many survived the collapse and died waiting under the rubble, because rescuers didn't know where to dig. My parents were under that rubble."* |
| **0:15–0:30** | Slow orbit. | *"Fifty years later, the first hour still runs blind. Damage models like FEMA HAZUS can say a district is bad, but not which building fell or who's inside, and nobody corrects them as evidence arrives. Argus is for the incident commander in that hour. It doesn't just simulate the quake. It watches the city afterwards and keeps correcting itself with Gemini 4 Argon."* |
| **0:30–0:50** | Fly to the Ferry Building (`2`), then Chinatown (`3`); click **808 Grant Ave** (B3617, or add `&select=B3617` to the URL) to open the inspector. | *"This is San Francisco, rebuilt one-to-one from real data: five thousand six hundred and eighty-nine buildings from OpenStreetMap, heights from the city's LiDAR survey, year built and construction type from the assessor's records. This one, 808 Grant Avenue: 1907, unreinforced brick, five storeys. Remember it."* |
| **0:50–1:08** | Click **Simulate** on *San Andreas M7.8 — 1906 repeat*. The USGS card, the ShakeAlert banner, waves, collapses. Then toggle **ShakeMap**. | *"Now: a repeat of 1906, magnitude 7.8, fourteen kilometres out. The event arrives in USGS format. ShakeAlert fires, but we're in the blind zone. Shaking comes from fault distance and soil, every building sways at its own period, and the old brick comes down. Within minutes the HAZUS model gives every building damage odds — and it calls nearly everything 'major damage'. Thirty-three percent on the xBD scale. It can't tell which building is standing."* |
| **1:08–1:40** | Let AIR 1 sweep; show the AR-tagged frame; recon pins appear; open COMMUNITY REPORTS. Point at the chart climbing. | *"So Argon starts watching everything coming in. A police helicopter's video, with address tags on every building, streams to Gemini 4 Argon. Working blind — it never sees the model's guess — Argon reconstructs each building it sees, people on the rubble, fires and blocked streets, each tied to the exact second of video. Residents report from their phones in English, Chinese and Spanish, and Argon triages every message. The key: each observation shows how hard the ground really shook there, and the correction spreads to buildings no camera has reached. Watch the accuracy climb."* |
| **1:40–2:05** | The Argon plan card types out its rationale → click **Approve** → drones climb out on 3D paths, with live thumbnails. | *"Next, Argon asks where it's still blind. It writes a drone patrol plan with its reasons — the blocks the helicopter missed, the calls it isn't sure about — and holds one drone in reserve. Nothing flies until I approve. Argus turns the plan into 3D flight paths over every tower, orbiting each target with the camera locked on, and that close-up video goes straight back to Argon."* |
| **2:05–2:35** | Open Copilot (`C`). **Live:** type *"I have 10 fire engines, 20 police officers, 2 helicopters and 6 ambulances. Where do they go first?"* While it thinks, point at the situation strip. Then routes flow on the map → click **Dispatch**. | *"Now the commander's question, asked live. Every turn carries the whole city — verified incidents, blocked roads, real fire stations and hospitals, travel times — in one context window. Argon ranks the trapped — there's 808 Grant, collapsed and burning — assigns every unit, and routes them around collapsed blocks, with helicopters for rooftops no truck can reach. Nothing moves until I click Dispatch."* |
| **2:35–2:50** | Switch to the end-state tab: the AIR panel **33% → 43%**, the chart, then the *24% → 55%* line. | *"The results, scored against the simulator's hidden truth: the whole downtown goes from thirty-three to forty-three percent, from seeing just seven percent of it. Every building Argon saw goes from twenty-four to fifty-five — more than double. And Argon's eight rescue sites hold twenty-one trapped survivors; the model's top eight held ten. Same crews. Twice the lives within reach."* |
| **2:50–3:00** | Pull back to the night city. | *"Only Argon makes this possible: it reads moving video down to the address, holds a whole city in one context, and answers in structure we can act on. In Tangshan, rescuers searched blind. With Argus, they don't have to."* |

### Numbers used
From the recorded live run (1906 repeat at 15:00), scored against the simulator's hidden truth. Argon never sees the truth.

| Claim | Value |
|---|---|
| Buildings | 5,689 (OSM footprints; 1,550 with DataSF LiDAR heights; 4,784 with assessor year and construction type) |
| Whole core area (1,902 buildings), xBD macro-F1 | 33.4% → 38.8% after the helicopter → **43.2%** at the end |
| Buildings seen on video (121), scored on the same buildings | 23.7% → **55.0%** |
| Coverage | 43% of the core area flown; 7% of buildings assessed one by one |
| Resident reports | 198 triaged; 77% linked to the right building; damage read correctly on 96.5% of those |
| Trapped survivors at the Copilot's 8 sites vs the model's top 8 | **21 vs 10** |
| Latency | ~20 s per 15-s helicopter clip, ~12 s per drone orbit, seconds for a drone plan, ~20 s per Copilot answer |

### Likely judge questions (one-line answers)
- *Is the city real?* Yes. Footprints, heights, construction years and types come from OpenStreetMap and DataSF. The quake and the "truth" are simulated, and truth is used only to score.
- *Does Argon see the answer?* No. Reconstruction is blind, and the planner and Copilot see only Argon's observations plus the model's prediction.
- *Why not a classical CV model?* Argon reads AR address tags off moving oblique video, reasons about "the building across the street" in resident texts, and writes plans and rationales. That is one model doing five jobs.
- *What's live right now?* The Copilot question just now. The helicopter and drone pass is a recorded live gemini-4-argon run, replayed for stage reliability.
- *What's next?* 911 calls and news hotlines, real drone and helicopter streams, and CAD integration. These are roadmap, not built yet.
