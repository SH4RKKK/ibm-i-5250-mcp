# The sign on lands on a menu with a command line

A worked example of the format, and a real test: it proves a session comes up
where the profile says it should. Copy it as a starting point and change the
screen titles, which are whatever your box's language calls them. The ones here
are from a Dutch box, so `Hoofdmenu` is the main menu and `OPDRACHTEN OPGEVEN`
is Command Entry.

Everything outside a fenced block is ignored. The heading becomes the test name.

The session is already signed on when a test starts, so the first thing to check
is where it landed. A `5250-expect` block with no `5250-do` before it checks
the screen that is already there.

```5250-expect
keyboard: unlocked
text: Hoofdmenu
```

`fields` counts input fields only. A menu has one, its command line, so this
also proves there is somewhere to type.

```5250-expect
fields: 1
```

Now start something. Under restricted mode, ten job scoped commands can be typed
on a command line, plus whatever is in `IBMI_ALLOWED_CL`. The README lists them.
`type f1` names the field by the ref the snapshot gives it, and `row,col` works
too.

```5250-do
type f1: call qsys/qcmd
key: Enter
```

A command entry screen has a command line and a request level. `not text`
guards against the thing that should not be there, so translate it too, or it
passes for the wrong reason.

```5250-expect
text: OPDRACHTEN OPGEVEN
not text: Attempt to Recover
message: none
```

Leave the way you came, so the next test starts from the menu rather than from
wherever this one stopped. Tests share one session and run in file order.

```5250-do
key: F3
```

```5250-expect
text: Hoofdmenu
```

## What else you can write

`field f1: SOMEVALUE` checks a field's exact value, with trailing blanks
trimmed. A nondisplay field reads as `<nondisplay>` rather than its contents,
so a password cannot be asserted into the open.

`cursor: 6,53` checks where the cursor was left, which is how a program tells
the operator which field it rejected.

`message: CPF9898` checks the message line contains that id, and
`message: none` checks there is no message at all. It needs a real IBM i
message id, so a program that writes plain text with no id will not match.

`signature: ca040eee10bd` pins the structural signature, which is the geometry
of the input fields hashed, so it survives changing data, dates and names. Use
it as a tripwire, not as the meaning of a test: when it fails it tells you the
screen changed and nothing whatsoever about how. The readable assertions above
are what make a failure diagnosable.
