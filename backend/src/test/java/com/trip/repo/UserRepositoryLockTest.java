package com.trip.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;

import jakarta.persistence.LockModeType;

import org.junit.jupiter.api.Test;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

class UserRepositoryLockTest {

    @Test
    void passwordProbeReadsOnlyTheHashBeforeTheLockedEntityRead() throws Exception {
        Method method = UserRepository.class.getMethod("findPasswordHashById", Long.class);

        assertThat(method.getAnnotation(Query.class).value())
            .isEqualTo("SELECT u.passwordHash FROM User u WHERE u.id = :userId");
    }

    @Test
    void findByIdForUpdateUsesAPessimisticUserRowLock() throws Exception {
        Method method = UserRepository.class.getMethod("findByIdForUpdate", Long.class);

        assertThat(method.getAnnotation(Lock.class).value())
            .isEqualTo(LockModeType.PESSIMISTIC_WRITE);
        assertThat(method.getAnnotation(Query.class).value())
            .isEqualTo("SELECT u FROM User u WHERE u.id = :userId");
    }
}
