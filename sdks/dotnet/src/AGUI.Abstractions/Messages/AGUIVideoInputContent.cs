namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIVideoInputContent : AGUIMediaInputContent
{
    public override string Type => AGUIInputContentTypes.Video;
}
