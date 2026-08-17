
namespace AGUIDojoServer.A2UI;

// Project-specific composition rules for the A2UI subagent — tells it how to use the pre-made domain components shipped in the dojo's dynamic catalog. Mirrors the LangGraph dojo examples so all integrations exercise the same demos.
internal static class A2UICompositionGuides
{
    // The catalog id of the dojo's dynamic component catalog.
    public const string DynamicCatalogId = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

    // The planner system prompt for the dynamic-schema and recovery demos.
    public const string PlannerInstructions = """
        You are a helpful assistant that creates rich visual UI on the fly.

        When the user asks for visual content (product comparisons, dashboards, lists, cards, etc.),
        use the generate_a2ui tool to create a dynamic A2UI surface.
        IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered.
        """;

    // The composition guide for the dynamic-schema demo.
    public const string DynamicSchema = """
        ## Available Pre-made Components

        You have 4 components. Use Row as the root with structural children to repeat a card per item.

        ### Row
        Layout container. Use structural children to repeat a card template:
          {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

        ### HotelCard
        Props: name, location, rating (number 0-5), pricePerNight, amenities (optional), action
        Example:
          {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},
           "rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},
           "action":{"event":{"name":"book","context":{"name":{"path":"name"}}}}}

        ### ProductCard
        Props: name, price, rating (number 0-5), description (optional), badge (optional), action
        Example:
          {"id":"card","component":"ProductCard","name":{"path":"name"},"price":{"path":"price"},
           "rating":{"path":"rating"},"description":{"path":"description"},
           "action":{"event":{"name":"select","context":{"name":{"path":"name"}}}}}

        ### TeamMemberCard
        Props: name, role, department (optional), email (optional), avatarUrl (optional), action
        Example:
          {"id":"card","component":"TeamMemberCard","name":{"path":"name"},"role":{"path":"role"},
           "department":{"path":"department"},"email":{"path":"email"},
           "action":{"event":{"name":"contact","context":{"name":{"path":"name"}}}}}

        ## RULES
        - Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
        - Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
        - Always provide data in the "data" argument as {"items":[...]}
        - Pick the card type that best matches the user's request
        - Generate 3-4 realistic items with diverse data
        """;

    // The composition guide for the recovery demo (structural validation showcase).
    public const string Recovery = """
        ## Available Pre-made Components

        Use Row as the root with structural children to repeat a card per item.

        ### Row
        Layout container. Repeat a card template via structural children:
          {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

        ### HotelCard / ProductCard / TeamMemberCard
        Card components bound to per-item data (relative paths inside the template).

        ## RULES
        - Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
        - ALWAYS include the referenced card component in the components array.
        - Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
        - Always provide data in the "data" argument as {"items":[...]}
        - Generate 3-4 realistic items with diverse data.
        """;
}
