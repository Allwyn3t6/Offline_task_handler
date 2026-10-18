"""Builds lyrics_to_song.ipynb. Run: python build_notebook.py"""
import json, textwrap

def md(s): return {"cell_type": "markdown", "metadata": {}, "source": textwrap.dedent(s).strip().splitlines(True)}
def _strip4(s): return "\n".join(l[4:] if l.startswith("    ") else l for l in s.strip("\n").splitlines())
def code(s): return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": _strip4(s).strip().splitlines(True)}

GEN_SCRIPT = '''
import json, os, sys
os.environ.pop("HTTP_PROXY", None); os.environ.pop("HTTPS_PROXY", None)
sys.path.insert(0, os.getcwd())
from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.inference import GenerationParams, GenerationConfig, generate_music

cfg = json.load(open(sys.argv[1]))
root = os.getcwd()
dit = AceStepHandler()
msg, ok = dit.initialize_service(project_root=root, config_path=cfg["dit"], device="auto", offload_to_cpu=False)
if not ok: sys.exit("DiT init failed: " + msg)
llm = LLMHandler()
msg, ok = llm.initialize(checkpoint_dir=os.path.join(root, "checkpoints"), lm_model_path=cfg["lm"],
                         backend="pt", device="auto", offload_to_cpu=False, dtype=None)
if not ok: sys.exit("LM init failed: " + msg)

params = GenerationParams(
    task_type="text2music", thinking=True,
    caption=cfg["caption"], lyrics=cfg["lyrics"], instrumental=cfg["instrumental"],
    vocal_language=cfg["language"], bpm=cfg["bpm"] or None, keyscale=cfg["keyscale"],
    duration=cfg["duration"], inference_steps=8, guidance_scale=1.0, seed=cfg["seed"],
)
config = GenerationConfig(batch_size=cfg["variations"], audio_format="mp3")
res = generate_music(dit, llm, params=params, config=config, save_dir=cfg["out_dir"])
if not res.success: sys.exit("Generation failed: " + str(res.error or res.status_message))
print("SONGS:" + json.dumps([a["path"] for a in res.audios]))
'''

cells = [
md("""
# Lyrics to Song (free, Suno-style) with ACE-Step 1.5

Turn your lyrics and a style description into a full song with vocals, using the open-source
[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) model on a free Colab GPU.

1. **Runtime → Change runtime type → T4 GPU** (free).
2. Run **Step 1** (about 10 to 20 minutes the first time: it installs and downloads the models).
3. Edit your song in **Step 2** and run it. Run Step 2 again for each new song.

Free Colab sessions can disconnect, so download songs you like.
"""),
md("## Step 1: Install (once per session)"),
code('''
    import subprocess, os, torch
    assert torch.cuda.is_available(), "No GPU. Use Runtime > Change runtime type > T4 GPU."
    print("GPU:", torch.cuda.get_device_name(0))

    def sh(cmd, cwd=None):
        p = subprocess.run(cmd, shell=True, cwd=cwd, text=True, capture_output=True)
        if p.returncode: raise RuntimeError(f"{cmd}\\n{p.stdout[-2000:]}\\n{p.stderr[-2000:]}")
        return p.stdout

    if not os.path.exists("ACE-Step-1.5"):
        sh("pip -q install uv")
        sh("git clone --depth 1 https://github.com/ACE-Step/ACE-Step-1.5.git")
    print("Installing dependencies (several minutes)...")
    sh("uv sync", cwd="ACE-Step-1.5")
    print("Downloading models (several GB, several minutes)...")
    sh("uv run acestep-download", cwd="ACE-Step-1.5")
    print("Ready.")
'''),
md("""
## Step 2: Write your song and generate

Use section tags in the lyrics: `[Intro]`, `[Verse 1]`, `[Chorus]`, `[Bridge]`, `[Outro]`.
The style description is the most important setting: name the genre, mood, instruments, vocal type and tempo.
"""),
code('''
    #@title Song settings { display-mode: "form" }
    style = "upbeat indie pop, bright acoustic guitar, punchy drums, warm female vocals, catchy hook, feel-good summer mood"  #@param {type:"string"}
    lyrics = """[Verse 1]
Windows down on the open road
Sunlight spilling over everything we know
Radio up and the worries fade
Every mile is a promise that we made

[Chorus]
We're driving into the golden light
Nothing holding us tonight
Sing it loud, let it ring
Freedom is the only thing

[Verse 2]
Dust on the dash and a map we never read
Taking every turn where the wild winds led
Stars come out and the engine hums
Somewhere ahead the best of it comes

[Chorus]
We're driving into the golden light
Nothing holding us tonight
Sing it loud, let it ring
Freedom is the only thing

[Outro]
Freedom is the only thing"""  #@param {type:"string"}
    language = "en"  #@param ["en","zh","ja","ko","es","fr","de","pt","ru","it","unknown"]
    instrumental = False  #@param {type:"boolean"}
    duration_seconds = 90  #@param {type:"slider", min:30, max:240, step:10}
    bpm = 0  #@param {type:"integer"}  # 0 = let the model choose
    key_scale = ""  #@param {type:"string"}  # e.g. "A minor"; empty = model chooses
    variations = 2  #@param {type:"slider", min:1, max:3, step:1}
    seed = -1  #@param {type:"integer"}  # -1 = random
    lm_model = "acestep-5Hz-lm-1.7B"  #@param ["acestep-5Hz-lm-0.6B","acestep-5Hz-lm-1.7B"]
    dit_model = "acestep-v15-turbo"  #@param ["acestep-v15-turbo"]

    import json, os, subprocess
    from IPython.display import Audio, display

    out_dir = os.path.abspath("songs"); os.makedirs(out_dir, exist_ok=True)
    cfg = dict(caption=style, lyrics="" if instrumental else lyrics, instrumental=instrumental,
               language=language, bpm=bpm, keyscale=key_scale, duration=float(duration_seconds),
               variations=int(variations), seed=int(seed), lm=lm_model, dit=dit_model, out_dir=out_dir)
    json.dump(cfg, open("song_config.json", "w"))
    open("ACE-Step-1.5/gen_song.py", "w").write(GEN_SCRIPT)

    print("Generating (loads models, then renders; a few minutes)...")
    p = subprocess.run("uv run python gen_song.py ../song_config.json", shell=True, cwd="ACE-Step-1.5",
                       text=True, capture_output=True)
    paths = []
    for line in p.stdout.splitlines():
        if line.startswith("SONGS:"): paths = json.loads(line[6:])
    if not paths:
        print(p.stdout[-3000:]); print(p.stderr[-3000:]); raise SystemExit("Generation failed, see log above.")
    for i, path in enumerate(paths, 1):
        print(f"Version {i}: {path}")
        display(Audio(path))
'''),
md("## Step 3: Download your songs"),
code('''
    from google.colab import files
    import glob
    for f in sorted(glob.glob("songs/*.mp3")): files.download(f)
'''),
md("""
### Tips
- **Out of memory?** Choose the `0.6B` language model and fewer variations.
- **Vocals mumbled?** Shorten lines, put one idea per line, and keep sections to 4 to 8 lines.
- **Wrong vibe?** Rewrite only the style text; keep seed `-1` to explore, or reuse a seed you liked.
- Songs are for your own use; check the ACE-Step license before commercial use.
"""),
]
# The generator script is injected as a variable cell so the notebook is self-contained.
cells.insert(3, code("GEN_SCRIPT = " + repr(GEN_SCRIPT.strip() + "\n")))
nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"gpuType": "T4", "provenance": []},
      "kernelspec": {"name": "python3", "display_name": "Python 3"}}, "nbformat": 4, "nbformat_minor": 5}
json.dump(nb, open("lyrics_to_song.ipynb", "w"), indent=1)
print("wrote lyrics_to_song.ipynb")
