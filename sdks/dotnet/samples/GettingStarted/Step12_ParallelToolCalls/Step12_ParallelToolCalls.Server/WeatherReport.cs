namespace Step12_ParallelToolCalls.Server;

internal sealed class WeatherReport
{
    public string City { get; set; } = string.Empty;
    public string Conditions { get; set; } = string.Empty;
    public int TemperatureCelsius { get; set; }
}
