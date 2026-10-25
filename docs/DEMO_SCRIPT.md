# Argus — 1-minute demo script

**Setup:** `cd web && npm run dev`, then open
`http://127.0.0.1:5173/?cam=overview&tod=15&quake=san_andreas_1906&speed=4&air=replay`
(replay mode: recorded gemini-4-argon responses, no waiting, works offline).
Record at 1600×900 or larger. Voiceover: about 150 words, calm and confident.

| Time | On screen | Voiceover |
|---|---|---|
| **0:00–0:07** | Slow push-in over San Francisco at dawn. | *"1976, Tangshan. Two hundred and forty thousand people died. My parents were buried in the rubble. Rescuers didn't know where to look."* |
| **0:07–0:15** | The USGS event card slides in, the ShakeAlert banner fires, and the city shakes: collapses, dust, the power going out. | *"This is Argus: a real-data twin of San Francisco, five thousand six hundred buildings, hit by a repeat of the 1906 earthquake."* |
| **0:15–0:27** | AIR 1 sweeps the city and the grey veil lifts behind it. Cut to the AR-tagged helicopter frame, then to recon pins appearing: *Collapsed · 6 people trapped*. | *"A police helicopter streams video to Gemini 4 Argon. Argon reconstructs every building it sees — collapses, fires, people on rooftops — and corrects the earthquake model for the whole city."* |
| **0:27–0:38** | The Argon plan card appears, the rationale types out, and you click **Approve**. Drones lift off and three live thumbnails start recording. | *"Then Argon decides where it is still blind and proposes drone missions. The commander approves. Close-up footage closes the gaps."* |
| **0:38–0:50** | Open Copilot and click the first quick prompt. The answer types out, routes flow across the streets with P1–P3 markers, and you click **Dispatch**: units move and ETAs count down. | *"Now the commander just asks: ten engines, twenty officers, two helicopters — what do I do? Argon ranks the trapped, routes every unit around blocked streets, and explains why."* |
| **0:50–0:57** | Resident-report cards popping up, then the accuracy chart climbing step by step to the final figure. | *"Residents report in, too, and Argon triages every message. On the buildings seen on video, the model alone scores twenty-four percent; corrected by Argon, forty-six."* |
| **0:57–1:00** | The ARGUS wordmark over the city at night. | *"Argus. See the city. Find the trapped."* |

### Optional closing line (roadmap — say it in the future tense)
> *"Next, Argus will listen to 911 calls and news hotlines, and fuse them with what it sees from the air."*

Only use this line as a roadmap statement. Don't show or imply that call monitoring works today: the demo must only show features that were built.

### Shot tips
- Before recording, set playback to 4× (or use `speed=4` in the URL) so the helicopter pass and both drone waves fit into one take. Then cut it down in editing.
- Best angles: the **Chinatown** preset (`3`) for the reconstruction pins, **Overview** (`1`) for the drones, and the camera's automatic fly-to when a Copilot plan appears.
- To show the Approve click for real, record that segment in live mode (`air=live`). Replay mode approves recorded plans on its own.
- Recorded Copilot questions (answers are instant in replay):
  1. *I have 10 fire engines, 20 police officers, 2 helicopters and 6 ambulances. How should I route them, and what are the priorities?*
  2. *How many people are confirmed trapped, and where?*
  3. *Which roads should police clear first?*
  4. *Where should the helicopters go?*
  5. *If Pine Street is cleared, what changes?*
