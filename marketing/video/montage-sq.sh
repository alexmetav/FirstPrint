#!/bin/bash
# montage.sh name file1 file2 ... -> name.png (4 per row, 400x400 each)
name=$1; shift
inputs=(); filt=""; i=0
for f in "$@"; do inputs+=(-i "$f"); filt+="[$i:v]scale=400:400[s$i];"; i=$((i+1)); done
n=$i; while [ $((n % 4)) -ne 0 ]; do inputs+=(-f lavfi -i "color=black:s=400x400"); filt+="[$n:v]null[s$n];"; n=$((n+1)); done
lay=""; for ((k=0;k<n;k++)); do x=$(( (k%4)*400 )); y=$(( (k/4)*400 )); lay+="${x}_${y}|"; done
st=""; for ((k=0;k<n;k++)); do st+="[s$k]"; done
ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "${filt}${st}xstack=inputs=$n:layout=${lay%|}" -frames:v 1 "$name.png"
