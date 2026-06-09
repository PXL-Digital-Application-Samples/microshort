package be.pxl.microshort.analytics.config;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class ServiceTokenFilter extends OncePerRequestFilter {

    @Value("${service.token}")
    private String serviceToken;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        if (req.getRequestURI().startsWith("/actuator")) {
            chain.doFilter(req, res);
            return;
        }
        String token = req.getHeader("X-Service-Token");
        if (serviceToken == null || !serviceToken.equals(token)) {
            res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            res.setContentType("application/json");
            res.getWriter().write("{\"error\":\"Unauthorized\"}");
            return;
        }
        chain.doFilter(req, res);
    }
}
