// The running server owns its own PID file.
//
// Why this exists: a launcher that captures the PID with a shell `echo $!` can
// record the WRONG pid — the `&`-backgrounded job in `start.sh` was a
// `cd && … node …` compound, so `$!` was the subshell's pid (or nohup's),
// depending on the shell's last-command exec optimisation, not node's. When
// they differed, `stop.sh`/`stop.bat` killed that wrapper, node was reparented
// to init and kept holding the port, and stop looked like it "did nothing" —
// intermittently, exactly per shell/platform. The Windows launcher had the
// mirror problem (Start-Process's tracked pid + a CommandLine match that can
// come back empty).
//
// The fix is to stop guessing: the process writes its OWN pid, which is
// authoritative and identical on every launch path (start.sh, start.bat, the
// .command, the tray, `npm start` from an editor, docker) and every platform.
// The launcher's own write stays as a pre-boot placeholder; this overwrites it
// with the truth the instant the server is actually listening.

import { writeFileSync, readFileSync, rmSync } from 'fs';

// Write my own pid so stop scripts kill ME, not a wrapper. Best-effort: if the
// write fails the launcher's placeholder is still there, so I never crash boot
// over it.
export function writePidFile(pidFile, pid = process.pid) {
  try { writeFileSync(pidFile, `${pid}\n`); return true; }
  catch { return false; }
}

// Remove the pid file on clean shutdown — but ONLY if it still names ME. A fast
// stop-then-start can have a successor already running and its pid in the file;
// deleting it then would strand the new instance as untracked. So I check the
// contents match my pid before unlinking.
export function clearPidFile(pidFile, pid = process.pid) {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(pid)) {
      rmSync(pidFile, { force: true });
      return true;
    }
  } catch { /* already gone, or unreadable — nothing to clean */ }
  return false;
}
