/**
 * Java fixture for the extractor regression test suite.
 *
 * Exercises: classes, interfaces, enums, constructors, methods,
 * inheritance (extends + implements), imports, and method invocations.
 *
 * Expected extraction floors (captured for T1861 snapshot):
 * - Definitions: >= 20 (classes + methods + constructors + interfaces + enums)
 * - Imports: >= 5
 * - Heritage: >= 4 (2 extends + 2 implements)
 */

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.HashMap;
import java.io.Serializable;
import java.util.*;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

public interface Drawable {
    void draw();
    String getColor();
}

public interface Resizable {
    void resize(double factor);
    double getArea();
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

public abstract class Shape implements Drawable, Resizable, Serializable {
    protected String color;
    protected double x;
    protected double y;

    public Shape(String color, double x, double y) {
        this.color = color;
        this.x = x;
        this.y = y;
    }

    @Override
    public String getColor() {
        return color;
    }

    public abstract double perimeter();

    public void move(double dx, double dy) {
        this.x += dx;
        this.y += dy;
    }
}

// ---------------------------------------------------------------------------
// Concrete class — extends + implements (via parent)
// ---------------------------------------------------------------------------

public class Circle extends Shape {
    private double radius;

    public Circle(String color, double x, double y, double radius) {
        super(color, x, y);
        this.radius = radius;
    }

    @Override
    public void draw() {
        System.out.println("Drawing circle at " + x + "," + y);
    }

    @Override
    public void resize(double factor) {
        this.radius *= factor;
    }

    @Override
    public double getArea() {
        return Math.PI * radius * radius;
    }

    @Override
    public double perimeter() {
        return 2 * Math.PI * radius;
    }

    public double getRadius() {
        return radius;
    }
}

// ---------------------------------------------------------------------------
// Another concrete class
// ---------------------------------------------------------------------------

public class Rectangle extends Shape {
    private double width;
    private double height;

    public Rectangle(String color, double x, double y, double width, double height) {
        super(color, x, y);
        this.width = width;
        this.height = height;
    }

    @Override
    public void draw() {
        System.out.println("Drawing rectangle " + width + "x" + height);
    }

    @Override
    public void resize(double factor) {
        this.width *= factor;
        this.height *= factor;
    }

    @Override
    public double getArea() {
        return width * height;
    }

    @Override
    public double perimeter() {
        return 2 * (width + height);
    }
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

public enum Color {
    RED, GREEN, BLUE, YELLOW, BLACK, WHITE;

    public boolean isLight() {
        return this == WHITE || this == YELLOW;
    }
}

// ---------------------------------------------------------------------------
// Generic class
// ---------------------------------------------------------------------------

public class ShapeRegistry<T extends Shape> {
    private List<T> shapes;
    private Map<String, T> namedShapes;

    public ShapeRegistry() {
        this.shapes = new ArrayList<>();
        this.namedShapes = new HashMap<>();
    }

    public void register(String name, T shape) {
        shapes.add(shape);
        namedShapes.put(name, shape);
    }

    public T find(String name) {
        return namedShapes.get(name);
    }

    public List<T> getAll() {
        return shapes;
    }

    public int size() {
        return shapes.size();
    }
}

// ---------------------------------------------------------------------------
// Utility class with static methods
// ---------------------------------------------------------------------------

public class ShapeUtils {
    private ShapeUtils() {
        // utility class — prevent instantiation
    }

    public static double totalArea(List<Shape> shapes) {
        double total = 0.0;
        for (Shape s : shapes) {
            total += s.getArea();
        }
        return total;
    }

    public static Shape largest(List<Shape> shapes) {
        Shape largest = null;
        for (Shape s : shapes) {
            if (largest == null || s.getArea() > largest.getArea()) {
                largest = s;
            }
        }
        return largest;
    }
}
