import subprocess,json,base64,pathlib,sys
# Download originals listed in animal-audio-sources.json before running.
root=pathlib.Path(__file__).resolve().parents[1]; source=pathlib.Path(sys.argv[1]); out={}
items=[(1,'mouse.mp3',3.8,0.85),(2,'cat.ogg',3.55,1.4),(3,'dog.ogg',0,.32),(4,'wolf.ogg',0,2.1),(5,'leopard.mp3',0,.768),(6,'tiger.mp3',0,2.15),(7,'lion.ogg',.25,2.2),(8,'elephant.ogg',.12,.93)]
for rank,name,start,duration in items:
 dst=str(source / f'clip-{rank}.mp3')
 subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source / name),'-t',str(duration),'-ac','1','-ar','44100','-af',f'loudnorm=I=-21:TP=-3:LRA=7,volume={0.5 if rank == 3 else 0.85},afade=t=in:d=0.008,afade=t=out:st={duration-.06}:d=0.06','-codec:a','libmp3lame','-b:a','80k',dst],check=True)
 out[str(rank)]={'duration':duration,'mp3':base64.b64encode(pathlib.Path(dst).read_bytes()).decode()}
(root/'src/ui/animal-recordings.json').write_text(json.dumps(out,separators=(',',':'))+'\n')
