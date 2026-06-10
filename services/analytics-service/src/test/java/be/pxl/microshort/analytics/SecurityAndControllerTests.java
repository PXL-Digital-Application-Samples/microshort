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

import static org.hamcrest.Matchers.anEmptyMap;
import static org.hamcrest.Matchers.hasItem;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
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

    @Test
    public void whenBatchIsEmpty_thenReturns400() throws Exception {
        mockMvc.perform(post("/events:batch")
                .header("X-Service-Token", "test-redirect-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[]"))
                .andExpect(status().isBadRequest());
    }

    @Test
    public void whenSingleEvent_thenReturns202() throws Exception {
        Mockito.doNothing().when(clickHouseRepository).insertBatch(Mockito.any());

        mockMvc.perform(post("/events")
                .header("X-Service-Token", "test-redirect-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"slug\":\"abc\",\"ts\":\"2024-01-01T00:00:00Z\",\"referrer\":\"\",\"userAgent\":\"test\",\"ipHash\":\"hash\"}"))
                .andExpect(status().isAccepted());
    }

    @Test
    public void whenCountsPostWithEmptyList_thenReturns200WithEmptyMap() throws Exception {
        mockMvc.perform(post("/stats/counts")
                .header("X-Service-Token", "test-url-token")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[]"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", anEmptyMap()));
    }

    // --- OpenAPI spec tests ---

    @Test
    public void openApiSpec_isAccessibleWithoutAuth() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));
    }

    @Test
    public void openApiSpec_containsExpectedPaths() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paths['/events:batch']").exists())
                .andExpect(jsonPath("$.paths['/events']").exists())
                .andExpect(jsonPath("$.paths['/stats/overview']").exists())
                .andExpect(jsonPath("$.paths['/stats/top']").exists())
                .andExpect(jsonPath("$.paths['/stats/counts']").exists());
    }

    @Test
    public void openApiSpec_definesServiceTokenSecurityScheme() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.components.securitySchemes.serviceToken").exists())
                .andExpect(jsonPath("$.components.securitySchemes.serviceToken.in").value("header"))
                .andExpect(jsonPath("$.components.securitySchemes.serviceToken.name").value("X-Service-Token"));
    }

    @Test
    public void docsPath_isNotBlockedBySecurityFilter() throws Exception {
        // SecurityFilter must pass /docs* through so Swagger UI can load in a browser
        int statusCode = mockMvc.perform(get("/docs")).andReturn().getResponse().getStatus();
        org.junit.jupiter.api.Assertions.assertNotEquals(401, statusCode,
            "/docs must not be blocked by SecurityFilter");
    }
}
