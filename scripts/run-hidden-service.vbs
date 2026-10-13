Option Explicit

Dim shell, command, index

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
command = QuoteArgument(WScript.Arguments(0))

For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

' Window style 0 keeps the child hidden before PowerShell initializes its console.
WScript.Quit shell.Run(command, 0, True)

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
