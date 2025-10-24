# Backlog and References

## TODO Items

- Snippets
- USB connect: EV3/Spike
- Better compilation for LEGO files (get pybrick content or switch to)
- Consider `TextDocumentContentProvider`  
  [VS Code Virtual Documents](https://code.visualstudio.com/api/extension-guides/virtual-documents)
- Consider `FileSystemProvider` for multi views  
  [VS Code FileSystemProvider](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider)
- Web extension  
  [VS Code Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)
- AI extensibility  
  [AI Extensibility Overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)
- Implement Pybricks autocomplete for the Pybricks Python language
- `characteristic.broadcast(broadcast[, callback(error)])` // broadcast is true|false
- `characteristic.discoverDescriptors([callback(error, descriptors)])`
- Generate SVGs simply and show them as base editors?
- [VS Code Panel UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/panel)
- **Feature:** Spike - tunnel
- **Plot:** Ability to group metrics to same axis
- Check/align USB with Pyb!
- Visual hint about curve/... turns given the current parameters

### FLL

- FLL: score test fraework with timer!

## DAP/PTU

- Add instrumentation for plot as well!
- Do not stop on each trap, communicate breakpoints
- Multi-file handling
- Add configurable AppData protocol
- Instrumentation: add a comment to the debug log
- On debug/pybricks: add the same DMTF sound as HubOS
- Possibility not to use the debugger (F5/Ctrl+F5 confusion, timing)
- Test with VirtualHub?
- DAP: request variable, do not send/augment it
- Emit observe data from host to Pybricks BLE
- Consider adding a payload size (u16) for AIPP
- User input feature through AIPP when connected
- create jupyter notebook engine
- disconnect after x idle minutes! / config

## Reference

- [VS Code Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [LEGO Spike Prime Docs](https://lego.github.io/spike-prime-docs/index.html)
- [LEGO BLE Wireless Protocol Docs](https://lego.github.io/lego-ble-wireless-protocol-docs/)
