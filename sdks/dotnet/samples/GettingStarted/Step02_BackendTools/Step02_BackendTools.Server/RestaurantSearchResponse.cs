namespace Step02_BackendTools.Server;

internal sealed class RestaurantSearchResponse
{
    public string Location { get; set; } = string.Empty;
    public string Cuisine { get; set; } = string.Empty;
    public RestaurantInfo[] Results { get; set; } = [];
}
