WEB SYNTH LAB - OFFLINE TEST PACKAGE

This folder is self-contained and does not download fonts, scripts, or styles.
Do not open index.html directly because browsers restrict module audio pages on file:// URLs.

macOS / Linux
1. Double-click START_OFFLINE.command, or run: sh START_OFFLINE.command
2. Open http://localhost:8080/
3. Stop the server with Control+C.

Windows
1. Double-click START_OFFLINE.bat.
2. Open http://localhost:8080/
3. Close the command window to stop the server.

Python 3 must already be installed. No internet connection is required after this folder has been copied.

Keyboard controls inside each synth:
- Space: trigger sound
- R: start or stop WAV recording
- Escape: stop the PRISM sequencer, active TITAN voice, or CONVERGENCE scene

Live instruments use stable 48kHz preview processing. CONVERGENCE FORGE renders and captures final assets at 96kHz. Recordings are stereo 24-bit WAV files and automatically stop and download at the 5-minute safety limit.
