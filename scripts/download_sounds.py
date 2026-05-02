#!/usr/bin/env python3
"""Download free sound effects for MeetingBoost packs."""

import os
import subprocess
import sys
import urllib.request

SOUNDS_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'sounds')

DL_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://pixabay.com/',
}

# pack -> [(filename, cdn_url)]
PACKS = {
    'classics': [
        ('rimshot',      'https://cdn.pixabay.com/download/audio/2022/03/15/audio_2c1cb36319.mp3?filename=freesound_community-rimshot-joke-funny-80325.mp3'),
        ('sad-trombone', 'https://cdn.pixabay.com/download/audio/2021/08/04/audio_c003cb2711.mp3?filename=freesound_community-wah-wah-sad-trombone-6347.mp3'),
        ('airhorn',      'https://cdn.pixabay.com/download/audio/2022/03/10/audio_f6e833c537.mp3?filename=freesound_community-dj-airhorn-38014.mp3'),
        ('applause',     'https://cdn.pixabay.com/download/audio/2023/01/23/audio_6082a83a07.mp3?filename=gregorquendel_sounddesign-crowd-people-street-concert-crowd-applause-and-clapping-136318.mp3'),
        ('crickets',     'https://cdn.pixabay.com/download/audio/2025/08/26/audio_b91b1cb269.mp3?filename=u_uy2kad5rlq-crickets-395138.mp3'),
        ('ding',         'https://cdn.pixabay.com/download/audio/2025/09/09/audio_2556e69436.mp3?filename=dragon-studio-ding-402325.mp3'),
        ('bruh',         'https://cdn.pixabay.com/download/audio/2021/08/09/audio_e00c3caecf.mp3?filename=freesound_community-bruh-sound-effect-1-6970.mp3'),
        ('fail-trumpet', 'https://cdn.pixabay.com/download/audio/2025/08/03/audio_4f0ce1aeca.mp3?filename=universfield-fail-trumpet-02-383962.mp3'),
        ('evil-laugh',   'https://cdn.pixabay.com/download/audio/2022/03/15/audio_6b3f80310f.mp3?filename=freesound_community-evil-laugh-89423.mp3'),
        ('booing',       'https://cdn.pixabay.com/download/audio/2026/03/02/audio_157f6090dd.mp3?filename=dragon-studio-crowd-booing-494319.mp3'),
    ],
    'corporate': [
        ('synergy-sting', 'https://cdn.pixabay.com/download/audio/2021/08/04/audio_12b0c7443c.mp3?filename=freesound_community-success-fanfare-trumpets-6185.mp3'),
        ('spy-theme',     'https://cdn.pixabay.com/download/audio/2026/02/11/audio_297be570ec.mp3?filename=emmraan-swinging-spy-theme-483280.mp3'),
        ('modem',         'https://cdn.pixabay.com/download/audio/2024/02/05/audio_6d0192df01.mp3?filename=liecio-old-internet-modem-dialing-189735.mp3'),
        ('buzzer',        'https://cdn.pixabay.com/download/audio/2022/02/11/audio_7f0bf4cdc0.mp3?filename=eritnhut1992-buzzer-or-wrong-answer-20582.mp3'),
        ('sonar-ping',    'https://cdn.pixabay.com/download/audio/2022/03/19/audio_2542614b50.mp3?filename=freesound_community-sonar-ping-95840.mp3'),
        ('lets-go',       'https://cdn.pixabay.com/download/audio/2022/03/26/audio_7a5b67358d.mp3?filename=freesound_community-lets-go-107109.mp3'),
        ('notification',  'https://cdn.pixabay.com/download/audio/2025/05/01/audio_f41477f1af.mp3?filename=dragon-studio-notification-ping-335500.mp3'),
        ('clown-horn',    'https://cdn.pixabay.com/download/audio/2022/03/10/audio_2e72d481c2.mp3?filename=freesound_community-clown-horn-44595.mp3'),
    ],
    'hype': [
        ('air-horn',      'https://cdn.pixabay.com/download/audio/2025/07/09/audio_ecfd3d257f.mp3?filename=dragon-studio-air-horn-sound-effect-372453.mp3'),
        ('power-up',      'https://cdn.pixabay.com/download/audio/2025/06/12/audio_542df1ee3b.mp3?filename=pwlpl-power-up-game-sound-effect-359227.mp3'),
        ('guitar-riff',   'https://cdn.pixabay.com/download/audio/2022/03/26/audio_1e4a93d399.mp3?filename=freesound_community-electric-guitar-metal-riff-107087.mp3'),
        ('party-horn',    'https://cdn.pixabay.com/download/audio/2022/03/14/audio_d646c1c473.mp3?filename=freesound_community-party-horn-68443.mp3'),
        ('vine-boom',     'https://cdn.pixabay.com/download/audio/2023/08/17/audio_47f3cbb256.mp3?filename=fzst-vine-boom-162668.mp3'),
        ('achievement',   'https://cdn.pixabay.com/download/audio/2025/06/18/audio_3e758ebcf4.mp3?filename=pwlpl-achievement-unlocked-361842.mp3'),
        ('royal-fanfare', 'https://cdn.pixabay.com/download/audio/2025/12/20/audio_7cef899ee2.mp3?filename=delon_boomkin-royal-entrance-brass-fanfare-454385.mp3'),
    ],
}

# YouTube clips via yt-dlp: [(pack, filename, youtube_url, start_sec, duration_sec)]
# These supplement the Pixabay set with iconic meme sounds only available on YouTube.
YOUTUBE_CLIPS = [
    ('classics', 'to-be-continued', 'https://www.youtube.com/watch?v=aBr2kKAHN6M', 0, 8),
    ('hype',     'mlg-airhorn',     'https://www.youtube.com/watch?v=Sdup0V__7r0', 0, 4),
    ('corporate','dial-tone',       'https://www.youtube.com/watch?v=gSEkiNMFGdA', 0, 5),
]


def download_cdn(name: str, url: str, dest: str) -> bool:
    if os.path.exists(dest) and os.path.getsize(dest) > 5000:
        print(f'  SKIP {os.path.relpath(dest)}')
        return True
    req = urllib.request.Request(url, headers=DL_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        if len(data) < 2000:
            print(f'  FAIL {name} — {len(data)}B (likely blocked)')
            return False
        with open(dest, 'wb') as f:
            f.write(data)
        print(f'  OK   {name}.mp3  ({len(data)//1024} KB)')
        return True
    except Exception as e:
        print(f'  ERR  {name}: {e}')
        return False


def download_youtube(pack: str, name: str, url: str, start: int, dur: int) -> bool:
    dest = os.path.join(SOUNDS_DIR, pack, f'{name}.mp3')
    if os.path.exists(dest) and os.path.getsize(dest) > 2000:
        print(f'  SKIP {pack}/{name}.mp3')
        return True
    tmp = dest.replace('.mp3', '_full.%(ext)s')
    tmp_mp3 = dest.replace('.mp3', '_full.mp3')
    print(f'  yt-dlp {name}...')
    r = subprocess.run([
        'yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '-o', tmp, url
    ], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp_mp3):
        print(f'  FAIL yt-dlp {name}: {r.stderr[:120]}')
        return False
    # Trim with ffmpeg
    r2 = subprocess.run([
        'ffmpeg', '-y', '-ss', str(start), '-t', str(dur),
        '-i', tmp_mp3, '-acodec', 'libmp3lame', '-q:a', '2', dest
    ], capture_output=True)
    os.remove(tmp_mp3)
    if r2.returncode != 0:
        print(f'  FAIL ffmpeg trim {name}')
        return False
    print(f'  OK   {pack}/{name}.mp3  ({os.path.getsize(dest)//1024} KB)')
    return True


def main():
    print('MeetingBoost — Sound Downloader\n')
    total = ok = 0

    for pack, sounds in PACKS.items():
        print(f'\n[ {pack.upper()} — Pixabay ]')
        dest_dir = os.path.join(SOUNDS_DIR, pack)
        os.makedirs(dest_dir, exist_ok=True)
        for name, url in sounds:
            dest = os.path.join(dest_dir, f'{name}.mp3')
            total += 1
            if download_cdn(name, url, dest):
                ok += 1

    print(f'\n[ YOUTUBE CLIPS ]')
    for pack, name, url, start, dur in YOUTUBE_CLIPS:
        dest_dir = os.path.join(SOUNDS_DIR, pack)
        os.makedirs(dest_dir, exist_ok=True)
        total += 1
        if download_youtube(pack, name, url, start, dur):
            ok += 1

    print(f'\nDone: {ok}/{total} downloaded.')
    if ok < total:
        sys.exit(1)


if __name__ == '__main__':
    main()
