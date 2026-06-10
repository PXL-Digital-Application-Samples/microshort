package be.pxl.microshort.analytics;

import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
    "service.allowed-tokens=test-redirect-token,test-url-token,test-admin-token"
})
@AutoConfigureMockMvc
public class CorrelationIdFilterTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ClickHouseRepository clickHouseRepository;

    private static final String VALID_TOKEN = "test-admin-token";
    private static final String HEADER = "X-Request-ID";

    @Test
    public void whenNoRequestIdHeader_thenFilterGeneratesUUID() throws Exception {
        Mockito.when(clickHouseRepository.getOverview()).thenReturn(Map.of("total_clicks", 0L));

        MvcResult result = mockMvc.perform(get("/stats/overview")
                .header("X-Service-Token", VALID_TOKEN))
                .andExpect(status().isOk())
                .andReturn();

        String requestId = result.getResponse().getHeader(HEADER);
        assertNotNull(requestId, "X-Request-ID should be set in the response");
        assertDoesNotThrow(() -> UUID.fromString(requestId), "Generated X-Request-ID should be a valid UUID");
    }

    @Test
    public void whenRequestIdProvided_thenFilterPassesItThrough() throws Exception {
        Mockito.when(clickHouseRepository.getOverview()).thenReturn(Map.of("total_clicks", 0L));
        String expectedId = "my-correlation-id-12345";

        mockMvc.perform(get("/stats/overview")
                .header("X-Service-Token", VALID_TOKEN)
                .header(HEADER, expectedId))
                .andExpect(status().isOk())
                .andExpect(header().string(HEADER, expectedId));
    }

    @Test
    public void whenBlankRequestIdProvided_thenFilterGeneratesNewUUID() throws Exception {
        Mockito.when(clickHouseRepository.getOverview()).thenReturn(Map.of("total_clicks", 0L));

        MvcResult result = mockMvc.perform(get("/stats/overview")
                .header("X-Service-Token", VALID_TOKEN)
                .header(HEADER, "   "))
                .andExpect(status().isOk())
                .andReturn();

        String requestId = result.getResponse().getHeader(HEADER);
        assertNotNull(requestId);
        assertDoesNotThrow(() -> UUID.fromString(requestId));
    }
}
