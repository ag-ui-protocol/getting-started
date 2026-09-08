import type { A2UIMiddlewareConfig } from "@ag-ui/a2ui-middleware";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  HotelCardApi,
  ProductCardApi,
  RowApi,
  TeamMemberCardApi,
} from "./a2ui-catalog/apis";

const DOJO_A2UI_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

const dynamicComponentApis = [
  RowApi,
  HotelCardApi,
  ProductCardApi,
  TeamMemberCardApi,
];

const components = Object.fromEntries(
  dynamicComponentApis.map((componentApi) => {
    const schema = zodToJsonSchema(componentApi.schema, {
      target: "jsonSchema2019-09",
    }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return [
      componentApi.name,
      {
        allOf: [
          { $ref: "common_types.json#/$defs/ComponentCommon" },
          {
            properties: {
              component: { const: componentApi.name },
              ...(schema.properties ?? {}),
            },
            required: ["component", ...(schema.required ?? [])],
          },
        ],
      },
    ];
  }),
);

export const DOJO_A2UI_MIDDLEWARE_CONFIG = {
  injectA2UITool: true,
  defaultCatalogId: DOJO_A2UI_CATALOG_ID,
  schema: {
    catalogId: DOJO_A2UI_CATALOG_ID,
    components,
  },
} satisfies A2UIMiddlewareConfig;
