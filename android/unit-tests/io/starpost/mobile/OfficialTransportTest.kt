package io.starpost.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class OfficialTransportTest {
    @Test fun oldOfficialOriginsUseVerifiedIpEndpoints() {
        assertEquals("https://8.148.13.225", starpostTransport("https://starpost.com.cn"))
        assertEquals("https://8.148.13.225:8443", hubTransport("https://ffahub.net"))
        assertEquals("https://8.148.13.225", starpostTransport("https://8.148.13.225"))
    }
    @Test fun unrelatedServersAndPortsAreNotRemapped() {
        for (origin in listOf("https://example.test", "https://starpost.com.cn:9443", "https://starpost.com.cn.evil.test")) {
            assertEquals(origin, starpostTransport(origin))
        }
    }
}
