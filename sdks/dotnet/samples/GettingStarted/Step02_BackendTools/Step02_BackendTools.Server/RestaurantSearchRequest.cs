namespace Step02_BackendTools.Server;

internal sealed class RestaurantSearchRequest
{
    public string Location { get; set; } = string.Empty;
    public string Cuisine { get; set; } = "any";
}
