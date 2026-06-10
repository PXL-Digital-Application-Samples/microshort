package be.pxl.microshort.analytics;

import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
    "service.allowed-tokens=test-redirect-token,test-url-token,test-admin-token"
})
@AutoConfigureMockMvc
public class SecurityAndControllerTests {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ClickHouseRepository clickHouseRepository;

    @Test
    public void whenNoToken_thenReturns401() throws Exception {
        mockMvc.perform(get("/stats/overview"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    public void whenWrongToken_thenReturns401() throws Exception {
        mockMvc.perform(get("/stats/overview")
                .header("X-Service-Token", "wrong-token"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    public void whenCorrectAdminToken_thenAllowsStatsAccess() throws Exception {
        Mockito.when(clickHouseRepository.getOverview()).thenReturn(Map.of("total_clicks", 100L));

        mockMvc.perform(get("/stats/overview")
                .header("X-Service-Token", "test-admin-token"))
                .andExpect(status().isOk());
    }

    @Test
    public void whenCorrectUrlToken_thenAllowsCountsPostAccess() throws Exception {
        Mockito.when(clickHouseRepository.getCounts(Mockito.any())).thenReturn(Map.of("slug1", 5L));

        mockMvc.perform(post("/stats/counts")
                .header("X-Service-Token", "test-url-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[\"slug1\"]"))
                .andExpect(status().isOk());
    }

    @Test
    public void whenCountsPostExceedsLimit_thenReturns413() throws Exception {
        java.util.List<String> largeList = new java.util.ArrayList<>();
        for (int i = 0; i < 2005; i++) {
            largeList.add("slug" + i);
        }
        String content = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(largeList);

        mockMvc.perform(post("/stats/counts")
                .header("X-Service-Token", "test-url-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content(content))
                .andExpect(status().isPayloadTooLarge());
    }
}
