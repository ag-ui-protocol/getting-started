package com.agui.adk.hitl;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ToolCallLedgerTest {

    @Test
    void derivesProviderMissingIdsDeterministicallyByInvocationAndPosition() {
        ToolCallLedger ledger = new ToolCallLedger();

        assertThat(ledger.idFor("invocation-a", 2, null)).isEqualTo("generated:invocation-a:2");
        assertThat(ledger.idFor("invocation-a", 2, null)).isEqualTo("generated:invocation-a:2");
        assertThat(ledger.idFor("invocation-b", 2, null)).isNotEqualTo("invocation-a:2");
        assertThat(ledger.idFor("invocation-a", 3, null)).isNotEqualTo("invocation-a:2");
    }

    @Test
    void isolatesProviderIdsFromGeneratedIdsWithinOneGroup() {
        ToolCallLedger ledger = new ToolCallLedger();

        assertThat(ledger.idFor("same", 1, null)).isNotEqualTo(ledger.idFor("same", 1, "provider-id"));
    }

    @Test
    void givesSameNamedDistinctCallsDifferentGeneratedIds() {
        ToolCallLedger ledger = new ToolCallLedger();

        assertThat(ledger.idFor("invocation", 0, null)).isNotEqualTo(ledger.idFor("invocation", 1, null));
    }

    @Test
    void preservesEveryNonblankProviderSuppliedIdExactly() {
        ToolCallLedger ledger = new ToolCallLedger();

        assertThat(ledger.idFor("invocation", 0, "provider-id")).isEqualTo("provider-id");
        assertThat(ledger.idFor("invocation", 1, " generated:invocation:1 "))
                .isEqualTo(" generated:invocation:1 ");
    }
}
