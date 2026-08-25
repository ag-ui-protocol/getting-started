# NuGet package signing

The `AGUI.*` NuGet packages are **author-signed** during release so nuget.org
marks them as signed. Signing happens in the `publish-dotnet` job of
[`.github/workflows/publish-release.yml`](../../../.github/workflows/publish-release.yml),
in a seam between **pack** and **push**:

```
pack  →  SIGN (this seam)  →  verify  →  push
```

Signing uses a **DigiCert code-signing certificate** whose private key is stored
(non-exportable, RSA-HSM) in **Azure Key Vault**, applied with
[NuGetKeyVaultSignTool](https://github.com/novotnyllc/NuGetKeyVaultSignTool) and
GitHub OIDC — no long-lived secret is stored. The private key never leaves the
HSM; signing is a `keys/sign` operation executed inside the vault.

The seam is **inert by default**. Until you set the `SIGNING_PROVIDER` variable
to `keyvault` it does nothing and the release behaves exactly as before, so it
is safe to merge ahead of provisioning being complete.

> **Author vs. repository signature.** nuget.org always adds its own
> *repository* signature on push — that is automatic and unrelated to this.
> This seam adds the *author* signature, which carries the publisher identity
> (`CN=Tawkit, Inc.`) and flips the package to "signed".
>
> **Not the same as `AGUI.snk`.** The `.snk` / `SignAssembly` machinery is
> assembly *strong-naming* (identity inside the DLLs). It is unrelated to NuGet
> author signing and is left untouched.

## Turning it on

Set `SIGNING_PROVIDER=keyvault` on the **`nuget` environment** (Settings →
Environments → `nuget`), plus the config below. The
`Preflight — validate signing configuration` step fails the run with an explicit
list if any of these are missing, so a half-provisioned setup can't publish a
broken package.

| Name | Kind | Notes |
| --- | --- | --- |
| `SIGNING_PROVIDER` | var | `keyvault` |
| `AZURE_CLIENT_ID` | **secret** | App Registration (client) ID — _already set on the `nuget` env (2026-07-01)_ |
| `AZURE_TENANT_ID` | **secret** | Directory (tenant) ID — _already set_ |
| `AZURE_SUBSCRIPTION_ID` | **secret** | Subscription containing the vault — _already set_ |
| `AZURE_KEY_VAULT_URL` | **secret** | e.g. `https://cpk-signing-kv.vault.azure.net` |
| `CODE_SIGNING_CERT_NAME` | **secret** | Certificate name in the vault, e.g. `code-signing` |

The vault URL and cert name are not credentials, but are kept as **secrets** so
they stay out of the committed workflow and the public CI logs. Auth is
federated (OIDC) — no client secret is stored.

## How it works

1. `azure/login` exchanges the job's OIDC token (`id-token: write`) for an Azure
   login — using the App Registration's **environment-scoped federated
   credential** (subject `repo:ag-ui-protocol/ag-ui:environment:nuget`).
2. `az account get-access-token --resource https://vault.azure.net` mints a
   short-lived Key Vault data-plane token, which is masked and passed to the
   tool via `--azure-key-vault-accesstoken` (the only secret-free auth path —
   managed-identity / client-secret modes don't apply on GitHub runners).
3. `NuGetKeyVaultSignTool sign` signs each `*.nupkg` (one per call, hence the
   loop) with SHA-256 and an RFC 3161 timestamp from `timestamp.digicert.com`.
   `*.snupkg` symbol packages are intentionally not author-signed.
4. `dotnet nuget verify --all` gates the push — the release fails if a package
   isn't signed or the signature doesn't chain to a trusted root.

## Provisioning checklist

Ownership split: an Azure/subscription admin does 1–2, a repo admin does 3, a
nuget.org org admin does 4, then anyone triggers 5.

1. **Grant the CI identity Key Vault access.** The App Registration (client
   `AZURE_CLIENT_ID`) needs both roles on the vault — Crypto User to sign,
   Certificate User to read the cert:
   ```bash
   SP_OID=$(az ad sp show --id <AZURE_CLIENT_ID> --query id -o tsv)
   VID=$(az keyvault show --name cpk-signing-kv --query id -o tsv)
   az role assignment create --role "Key Vault Crypto User" \
     --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal --scope "$VID"
   az role assignment create --role "Key Vault Certificate User" \
     --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal --scope "$VID"
   ```
2. **Environment-scoped federated credential.** Because the job uses
   `environment: nuget`, the App Registration needs a federated credential with
   subject exactly `repo:ag-ui-protocol/ag-ui:environment:nuget` (issuer
   `https://token.actions.githubusercontent.com`, audience
   `api://AzureADTokenExchange`). A branch/ref-scoped credential will silently
   fail to log in.
3. **Set the `nuget` environment secrets/vars** from the table above:
   ```bash
   R=ag-ui-protocol/ag-ui
   gh secret set   AZURE_KEY_VAULT_URL    --env nuget --repo $R --body "https://cpk-signing-kv.vault.azure.net"
   gh secret set   CODE_SIGNING_CERT_NAME --env nuget --repo $R --body "code-signing"
   gh variable set SIGNING_PROVIDER       --env nuget --repo $R --body "keyvault"
   ```
4. **Register the certificate on nuget.org.** Export the public cert and
   register it under the **`ag-ui-protocol` org** → Manage → Certificates:
   ```bash
   az keyvault certificate download --vault-name cpk-signing-kv --name code-signing \
     --file agui-codesign.cer --encoding DER
   ```
   ⚠️ Enforcement is account-wide and immediate: once any cert is registered to
   the owner, **every** future push must be author-signed with a registered
   cert. Land this together with the signing CI (step 3) and the version bump
   (step 5) — don't register early, or an interim unsigned release will be
   rejected.
5. **Version bump + ship.** nuget.org versions are immutable, so signed
   packages must publish as a new version. Bump the shared `<VersionPrefix>` in
   [`sdks/dotnet/Directory.Build.props`](../Directory.Build.props) (e.g. `0.0.3`
   → `0.0.4`) — one bump re-releases all five packages, signed. (Optional:
   unlist the old unsigned versions so consumers move to the signed ones.)

## Why the DigiCert cert qualifies

nuget.org accepts an author signature whose cert chains to a root in the
Microsoft Trusted Root Program (DigiCert is a member), has the code-signing EKU,
RSA ≥ 2048 (this cert is RSA 3072), and carries a valid RFC 3161 timestamp — all
satisfied by the issued DigiCert code-signing certificate. Adding/removing certs
on nuget.org requires 2FA.
