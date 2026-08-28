Output assets/demo.gif

Require node
Require tmux

Set Shell "bash"
Set Width 1600
Set Height 1000
Set FontSize 16
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set Framerate 15
Set TypingSpeed 55ms
Set PlaybackSpeed 0.8
Set Theme "Catppuccin Mocha"
Set WindowBar Rings
Set WindowBarSize 32
Set CursorBlink false

Hide
Type "export PS1='$ '"
Enter
Type "export PATH=$PWD/bin:$PATH"
Enter
Type "cd demo"
Enter
Type "clear"
Enter
Show

Type "zaps"
Enter
Wait+Screen /3 ready/
Sleep 2s


Down 2
Sleep 1s
Type "l"
Wait+Screen /zaps: docs/
Sleep 2s


Escape
Type "t"
Wait+Screen /Type to filter tasks/
Type@50ms "check"
Sleep 1s
Enter
Sleep 2s


Type ":"
Wait+Screen /Type a command/
Type@80ms "restart"
Sleep 2s
Enter
Wait+Screen /starting|restarting/
Sleep 2s


Type "?"
Wait+Screen /zaps — help/
Sleep 2s


Escape


Type "d"
Wait+Screen /Shut down session?/

Type "y"

