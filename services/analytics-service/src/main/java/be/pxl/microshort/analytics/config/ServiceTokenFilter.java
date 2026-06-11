package be.pxl.microshort.analytics.config;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import jakarta.annotation.PostConstruct;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

@Component
public class ServiceTokenFilter extends OncePerRequestFilter {

    @Value("${service.allowed-tokens}")
    private String allowedTokensRaw;

    private Set<String> allowedTokens;

    @PostConstruct
    public void init() {
        allowedTokens = Arrays.stream(allowedTokensRaw.split(","))
            .map(String::trim)
            .filter(s -> !s.isBlank())
            .collect(Collectors.toSet());
    }

    private boolean safeTokenEqual(String a, String b) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] aBytes = md.digest(a.getBytes(StandardCharsets.UTF_8));
            md.reset();
            byte[] bBytes = md.digest(b.getBytes(StandardCharsets.UTF_8));
            return MessageDigest.isEqual(aBytes, bBytes);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        String uri = req.getRequestURI();
        if (uri.equals("/actuator/health") ||
            uri.startsWith("/actuator/health/") ||
            uri.startsWith("/v3/api-docs") ||
            uri.startsWith("/docs") ||
            uri.startsWith("/swagger-ui")) {
            chain.doFilter(req, res);
            return;
        }
        String token = req.getHeader("X-Service-Token");
        boolean authorized = token != null && allowedTokens.stream()
            .anyMatch(expected -> safeTokenEqual(expected, token));
        if (!authorized) {
            res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            res.setContentType("application/json");
            res.getWriter().write("{\"error\":\"Unauthorized\"}");
            return;
        }
        chain.doFilter(req, res);
    }
}
