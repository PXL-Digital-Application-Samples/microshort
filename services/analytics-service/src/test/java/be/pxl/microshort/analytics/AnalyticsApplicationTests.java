package be.pxl.microshort.analytics;

import be.pxl.microshort.analytics.repository.ClickHouseRepository;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;

@SpringBootTest
class AnalyticsApplicationTests {

    @MockBean
    private ClickHouseRepository clickHouseRepository;

    @Test
    void contextLoads() {
        // Spring context loads without ClickHouse (Repository mocked)
    }
}
