#!/usr/bin/env python3
"""Speaker verification using resemblyzer embeddings (d-vectors).
Fast, local, no API calls. ~50ms per verification."""

import sys, os, json, argparse
import numpy as np

PROFILES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'voice-profiles')
THRESHOLD = 0.72  # cosine similarity threshold

def ensure_dir():
    os.makedirs(PROFILES_DIR, exist_ok=True)

def load_audio(path):
    from resemblyzer import preprocess_wav
    from pathlib import Path
    return preprocess_wav(Path(path))

def get_embedding(wav):
    from resemblyzer import VoiceEncoder
    encoder = VoiceEncoder("cpu")
    return encoder.embed_utterance(wav)

# Cache encoder globally for speed
_encoder = None
def get_encoder():
    global _encoder
    if _encoder is None:
        from resemblyzer import VoiceEncoder
        _encoder = VoiceEncoder("cpu")
    return _encoder

def enroll(audio_path, profile="owner"):
    ensure_dir()
    profile_dir = os.path.join(PROFILES_DIR, profile)
    os.makedirs(profile_dir, exist_ok=True)

    wav = load_audio(audio_path)
    encoder = get_encoder()
    embedding = encoder.embed_utterance(wav)

    # Save embedding
    existing = [f for f in os.listdir(profile_dir) if f.endswith('.npy') and not f.startswith('.')]
    idx = len(existing) + 1
    path = os.path.join(profile_dir, f'sample_{idx}.npy')
    np.save(path, np.asarray(embedding, dtype=np.float32))

    # Compute and save centroid (average of all embeddings)
    all_embeddings = []
    for f in sorted(os.listdir(profile_dir)):
        if f.endswith('.npy') and f != 'centroid.npy' and not f.startswith('.'):
            all_embeddings.append(np.load(os.path.join(profile_dir, f), allow_pickle=True))
    centroid = np.mean(all_embeddings, axis=0) if all_embeddings else embedding
    np.save(os.path.join(profile_dir, 'centroid.npy'), np.asarray(centroid, dtype=np.float32))

    return {
        "success": True,
        "sample": idx,
        "total_samples": len(all_embeddings),
        "message": f"Amostra {idx} salva." + (
            f" Preciso de pelo menos 3. Mande mais {3 - len(all_embeddings)}."
            if len(all_embeddings) < 3
            else f" Perfil pronto com {len(all_embeddings)} amostras!"
        )
    }

def verify(audio_path, profile="owner"):
    profile_dir = os.path.join(PROFILES_DIR, profile)
    centroid_path = os.path.join(profile_dir, 'centroid.npy')

    if not os.path.exists(centroid_path):
        return {"match": True, "confidence": 0, "similarity": 0, "reason": "Sem perfil cadastrado"}

    wav = load_audio(audio_path)
    encoder = get_encoder()
    embedding = encoder.embed_utterance(wav)
    centroid = np.load(centroid_path, allow_pickle=True)

    # Cosine similarity
    similarity = float(np.dot(embedding, centroid) / (np.linalg.norm(embedding) * np.linalg.norm(centroid)))

    # Also compare against each individual sample for robustness
    similarities = []
    for f in os.listdir(profile_dir):
        if f.endswith('.npy') and f != 'centroid.npy' and not f.startswith('.'):
            sample = np.load(os.path.join(profile_dir, f), allow_pickle=True)
            sim = float(np.dot(embedding, sample) / (np.linalg.norm(embedding) * np.linalg.norm(sample)))
            similarities.append(sim)

    max_sim = max(similarities) if similarities else similarity
    avg_sim = float(np.mean(similarities)) if similarities else similarity

    # Use best of centroid or max individual similarity
    best_sim = max(similarity, max_sim)
    is_match = best_sim >= THRESHOLD

    return {
        "match": is_match,
        "confidence": round(best_sim, 4),
        "similarity_centroid": round(similarity, 4),
        "similarity_max": round(max_sim, 4),
        "similarity_avg": round(avg_sim, 4),
        "threshold": THRESHOLD,
        "reason": "Voz reconhecida" if is_match else "Voz não reconhecida"
    }

def status(profile="owner"):
    profile_dir = os.path.join(PROFILES_DIR, profile)
    if not os.path.exists(profile_dir):
        return {"samples": 0, "ready": False}
    samples = [f for f in os.listdir(profile_dir) if f.endswith('.npy') and f != 'centroid.npy' and not f.startswith('.')]
    return {
        "samples": len(samples),
        "ready": len(samples) >= 3,
        "has_centroid": os.path.exists(os.path.join(profile_dir, 'centroid.npy'))
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['enroll', 'verify', 'status'])
    parser.add_argument('--audio', help='Path to WAV file')
    parser.add_argument('--profile', default='owner')
    args = parser.parse_args()

    if args.action == 'enroll':
        if not args.audio:
            print(json.dumps({"success": False, "error": "--audio required"}))
            sys.exit(1)
        result = enroll(args.audio, args.profile)
    elif args.action == 'verify':
        if not args.audio:
            print(json.dumps({"match": False, "error": "--audio required"}))
            sys.exit(1)
        result = verify(args.audio, args.profile)
    elif args.action == 'status':
        result = status(args.profile)

    print(json.dumps(result))
