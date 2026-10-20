# ctxd key helper build

The helper requires macOS, a code signing identity and the owner's Touch ID check. Run these steps on the target Mac from the repository root.

```bash
swiftc native/ctxd-keyhelper/main.swift \
  -framework Security -framework LocalAuthentication \
  -o .build/ctxd-keyhelper
codesign --force --options runtime \
  --sign "<owner signing identity>" .build/ctxd-keyhelper
codesign --verify --strict --verbose=2 .build/ctxd-keyhelper
```

Place the signed binary on the server service path. Set `sealed.key_helper` to that absolute path. Test with a scratch pool:

```bash
.build/ctxd-keyhelper create <scratch-pool-id>
.build/ctxd-keyhelper get <scratch-pool-id>
.build/ctxd-keyhelper remove <scratch-pool-id>
```

The first two commands print a base64 key. They should request user presence. The final signing, installation, Keychain and Touch ID checks belong to the owner because they use owner identity and hardware.
