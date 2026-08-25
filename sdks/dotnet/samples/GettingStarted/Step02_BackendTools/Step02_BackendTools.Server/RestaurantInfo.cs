namespace Step02_BackendTools.Server;

internal sealed class RestaurantInfo
{
    public string Name { get; set; } = string.Empty;
    public string Cuisine { get; set; } = string.Empty;
    public double Rating { get; set; }
    public string Address { get; set; } = string.Empty;
}
