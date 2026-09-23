// The command line guard. Not the primary control: that is the IBM i user profile, lmtcpb(*yes) with
// authority to nothing that matters. All this sees is text going into a wide field low on the screen.

// Enough to configure this job, then run and debug a program in it. Every verb is job scoped: none
// touch data or create objects. A named list rather than a dsp* prefix rule, which would look safe
// and not be, since dspobjd writes a file when given an outfile. A site's own start command goes in
// IBMI_ALLOWED_CL, since every shop has one and none share a name.
const ALLOWED = new Set([
  "call", "strdbg", "enddbg",
  "chgcurlib", "addlible", "rmvlible", "chglibl",
  "dsplibl", "edtlibl", "signoff",
]);

// Prompt prefixes (?, ??, ?*, ?<, ?>) come off ahead of any library qualifier, or "?dltlib" walks
// past the check.
function verbOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] || "";
  const unprompted = first.replace(/^[?]+[*<>?]?/, "");
  return unprompted.slice(unprompted.lastIndexOf("/") + 1).toLowerCase();
}

// Checked only for text going into a command line: refusing "call" in a customer name field would be
// noise. Restricted mode is an allowlist. With it off there is no list of our own, only the verbs the
// operator named in IBMI_BLOCKED_CL.
export function assertCommandAllowed(
  command: string,
  opts: { restricted: boolean; allowedCl: string[]; blockedCl: string[] },
): void {
  if (!command.trim()) return;
  const verb = verbOf(command);

  if (opts.restricted) {
    if (ALLOWED.has(verb) || opts.allowedCl.includes(verb)) return;
    // An allowlist that permits what it could not parse is open by default. "? dltlib payroll" leaves
    // a bare "?" as the first token and an empty verb, and IBM i runs it as dltlib prompted.
    const why = verb
      ? `"${verb}" is not on the allowlist`
      : `"${command.trim()}" does not start with a command this can recognise`;
    throw new Error(
      `restricted mode: ${why}, so it will not be typed. ` +
        `Allowed here: ${[...ALLOWED, ...opts.allowedCl].join(", ")}. ` +
        `Add the verb to IBMI_ALLOWED_CL if the program under test needs it, or unset ` +
        `IBMI_RESTRICTED to lift the mode.`,
    );
  }

  if (verb && opts.blockedCl.includes(verb)) {
    throw new Error(
      `"${verb}" is on IBMI_BLOCKED_CL, so it will not be typed on a command line. ` +
        `The profile's authority on the box is what actually protects it.`,
    );
  }
}
