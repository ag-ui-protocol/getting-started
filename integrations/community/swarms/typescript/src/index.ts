/**
 * Swarms is a framework for building, deploying, and orchestrating multi-agent
 * systems. This package connects a Swarms agent (exposed over the AG-UI
 * protocol by the `ag-ui-swarms` Python adapter) to AG-UI compatible frontends.
 */

import { HttpAgent } from "@ag-ui/client";

/**
 * AG-UI client for a Swarms agent server.
 *
 * The Swarms Python adapter speaks the standard AG-UI HTTP/SSE wire format, so
 * this is a thin {@link HttpAgent} that points at a Swarms endpoint.
 */
export class SwarmsAgent extends HttpAgent {}
