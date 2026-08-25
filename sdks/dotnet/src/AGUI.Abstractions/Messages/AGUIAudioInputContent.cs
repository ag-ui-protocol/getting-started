namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIAudioInputContent : AGUIMediaInputContent
{
    public override string Type => AGUIInputContentTypes.Audio;
}
